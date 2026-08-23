/**
 * Ticker / market news: fan out to the enabled feeds in parallel under one deadline, parse,
 * keep items inside the time window that are about the requested symbols, tag tickers + event
 * type, dedupe syndicated copies (spread count) and return the newest first. No article bodies
 * are fetched here — the facade can read the top N through the normal pipeline when asked.
 */

import { classifyEvent } from './classify.js';
import { type MarketsClient, runSources, type SourceTask } from './client.js';
import { dedupeNews, newsId } from './dedupe.js';
import { type FeedItem, parseFeed } from './feed.js';
import { MARKET_SOURCES, marketSource, sourceUrl } from './sources.js';
import {
  extractTickers,
  mentionMatcher,
  normalizeSymbol,
  type TickerDirectory,
} from './tickers.js';
import type { MarketSource, NewsItem, NewsResult } from './types.js';
import { clampLimit } from './util.js';

export interface NewsOptions {
  symbols?: string[];
  query?: string;
  /** Look-back window in ms (default 24 h). */
  windowMs?: number;
  limit?: number;
  /** Include market-wide feeds (CNBC, MarketWatch, wires, Fed) filtered to the symbols (default true). */
  includeMarket?: boolean;
  /** Per-call deadline (ms); defaults to the client's policy. */
  deadlineMs?: number;
  signal?: AbortSignal;
  now?: number;
}

export const MAX_SYMBOLS = 5;
const TRUST = Object.fromEntries(MARKET_SOURCES.map((s) => [s.id, s.trust]));
const PER_TICKER = MARKET_SOURCES.filter((s) => s.kind === 'news' && s.perTicker);
const MARKET_WIDE = MARKET_SOURCES.filter((s) => s.kind === 'news' && !s.perTicker);
const QUERY_SOURCES = ['bing-news', 'google-news'].map(marketSource);

/** Google News titles end with " - Publisher"; split it off. */
function splitPublisher(title: string): { title: string; publisher?: string } {
  const m = /^(.*\S)\s+-\s+([^-]{2,60})$/.exec(title);
  return m ? { title: m[1] as string, publisher: m[2] } : { title };
}

function toNewsItem(it: FeedItem, source: MarketSource): NewsItem {
  let title = it.title;
  let publisher = it.sourceName;
  if (source.id === 'google-news') ({ title, publisher = publisher } = splitPublisher(title));
  let summary = it.summary;
  // Aggregators repeat the headline (Google: "Title Publisher") — keep only what adds to it.
  if (summary?.startsWith(title)) {
    const rest = summary
      .slice(title.length)
      .replace(/^[\s\-–—:|]+/, '')
      .trim();
    summary = rest && rest !== publisher ? rest : undefined;
  }
  const tickers = new Set(extractTickers(`${title} ${summary ?? ''}`));
  for (const c of it.categories) if (/^[A-Z]{1,5}$/.test(c)) tickers.add(c); // Benzinga-style ticker categories
  return {
    id: newsId(it.link, title),
    title,
    url: it.link ?? '',
    source: source.id,
    publisher,
    publishedAt: it.publishedAt,
    summary,
    tickers: [...tickers],
    event: classifyEvent(title, summary),
    spread: 1,
  };
}

function matchesQuery(text: string, query: string): boolean {
  const toks = query
    .toLowerCase()
    .split(/[^a-z0-9$.]+/)
    .filter((t) => t.length >= 3);
  const t = text.toLowerCase();
  return toks.every((tok) => t.includes(tok));
}

export async function getNews(
  client: MarketsClient,
  dir: TickerDirectory,
  opts: NewsOptions = {},
): Promise<NewsResult> {
  const now = opts.now ?? Date.now();
  const since = new Date(now - (opts.windowMs ?? 24 * 3_600_000)).toISOString();
  const limit = clampLimit(opts.limit, 15);
  const symbols = [...new Set((opts.symbols ?? []).map(normalizeSymbol).filter(Boolean))].slice(
    0,
    MAX_SYMBOLS,
  );
  const query = opts.query?.trim() || undefined;
  if (symbols.length) await dir.load(opts.signal);
  const matchers = new Map(symbols.map((s) => [s, mentionMatcher(s, dir.alias(s))]));

  // Collected per task: raw items that passed the window + relevance filters.
  const raw: NewsItem[] = [];
  let rawCount = 0;
  const tasks: SourceTask[] = [];
  const feedTask = (source: MarketSource, url: string, symbol?: string): SourceTask => ({
    source,
    run: async (signal) => {
      const r = await client.fetchText(source, url, { signal });
      const items = parseFeed(r.text, url).items;
      rawCount += items.length;
      const kept: NewsItem[] = [];
      const fallback: NewsItem[] = [];
      for (const fi of items) {
        if (fi.publishedAt && fi.publishedAt < since) continue;
        const item = toNewsItem(fi, source);
        const text = `${item.title} ${item.summary ?? ''}`;
        if (symbol) {
          // Per-ticker feed: trust the feed for the symbol, but aggregator feeds (Yahoo) pad with
          // loosely related pieces — prefer stories that actually mention the company.
          item.tickers = [...new Set([symbol, ...item.tickers])];
          (matchers.get(symbol)?.(text) ? kept : fallback).push(item);
        } else if (symbols.length) {
          const hit = symbols.filter((s) => item.tickers.includes(s) || matchers.get(s)?.(text));
          if (!hit.length) continue;
          item.tickers = [...new Set([...item.tickers, ...hit])];
          kept.push(item);
        } else if (!query || matchesQuery(text, query)) kept.push(item);
      }
      // Nothing explicit about the symbol: fall back to what the feed offered rather than nothing.
      const out = kept.length ? kept : fallback;
      raw.push(...out);
      return { count: out.length, fromCache: r.fromCache, stale: r.stale };
    },
  });

  for (const sym of symbols)
    for (const src of PER_TICKER)
      tasks.push(feedTask(src, sourceUrl(src, { symbol: sym, alias: dir.alias(sym) }), sym));
  if (!symbols.length && query)
    for (const src of QUERY_SOURCES) tasks.push(feedTask(src, sourceUrl(src, { query })));
  if (opts.includeMarket !== false)
    for (const src of MARKET_WIDE) tasks.push(feedTask(src, sourceUrl(src)));

  const sources = await runSources(client, tasks, {
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
  });
  const items = dedupeNews(raw, { trust: TRUST }).sort((a, b) => {
    if (a.publishedAt && b.publishedAt)
      return a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0;
    if (a.publishedAt) return -1;
    if (b.publishedAt) return 1;
    return b.spread - a.spread;
  });
  return {
    symbols,
    query,
    since,
    items: items.slice(0, limit),
    sources,
    rawCount,
    fetchedAt: new Date(now).toISOString(),
  };
}
