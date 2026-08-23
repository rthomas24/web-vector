/**
 * `markets` — news, SEC filings, event calendar, crowd sentiment and market pulse for trading /
 * research agents, built from free, keyless sources that were verified to allow it (see
 * `sources.ts` for the policy of each). Everything runs through the pipeline's polite Fetcher
 * and a TTL cache; nothing here touches the search → ingest → retrieve pipeline.
 *
 *   const wv = new WebVector();
 *   const news = await wv.markets.news({ symbols: ['NVDA'], windowMs: 12 * 3_600_000 });
 *   console.log(renderNews(news));
 */
import type { CacheDb } from '../cache/db.js';
import type { Fetcher } from '../ingest/fetcher.js';
import type { Logger } from '../types.js';
import { cleanUrl } from '../util/url.js';
import { MarketsCache } from './cache.js';
import { type CalendarOptions, getCalendar } from './calendar.js';
import { MarketsClient, type MarketsPolicy } from './client.js';
import {
  type FilingSearchOptions,
  type FilingsOptions,
  getFilings,
  searchFilings,
} from './filings.js';
import { getNews, type NewsOptions } from './news.js';
import { getPulse, type PulseOptions } from './pulse.js';
import { getSentiment, type SentimentOptions } from './sentiment.js';
import { MARKET_SOURCES } from './sources.js';
import { TickerDirectory } from './tickers.js';
import type {
  CalendarResult,
  FilingsResult,
  MarketSource,
  NewsResult,
  PulseResult,
  SentimentSnapshot,
} from './types.js';

export type { CacheEntry } from './cache.js';
export { MarketsCache } from './cache.js';
export type { CalendarOptions } from './calendar.js';
export { getCalendar, parseFfCalendar } from './calendar.js';
export { classifyEvent, classifyFiling, FORM_8K_ITEMS, labelItems } from './classify.js';
export type { MarketsClientOptions, MarketsPolicy, SourceTask, TextResponse } from './client.js';
export { failureReason, isNotFound, MarketsClient, runSources } from './client.js';
export type { DedupeOptions } from './dedupe.js';
export { dedupeNews, hamming, newsId, simhash64, storyKey, titleTokens } from './dedupe.js';
export type { FeedItem, ParsedFeed } from './feed.js';
export { parseDate, parseFeed } from './feed.js';
export type { FilingSearchOptions, FilingsOptions } from './filings.js';
export { filingUrls, getFilings, searchFilings } from './filings.js';
export type { NewsOptions } from './news.js';
export { getNews, MAX_SYMBOLS } from './news.js';
export type { PulseOptions } from './pulse.js';
export { DEFAULT_BASKET, getPulse, parseFredCsv, parseVixCsv, parseYahooChart } from './pulse.js';
export {
  age,
  capMarkdown,
  fmtEt,
  renderCalendar,
  renderFilings,
  renderNews,
  renderPulse,
  renderSentiment,
  renderSources,
  UNTRUSTED_NOTE,
} from './render.js';
export type { SentimentOptions } from './sentiment.js';
export { finraShortRow, getSentiment, summarizeStocktwits } from './sentiment.js';
export {
  listMarketSources,
  MARKET_SOURCES,
  MARKETS_BROWSER_UA,
  marketSource,
  robotsModeFor,
  sourceEnabled,
  sourceUrl,
} from './sources.js';
export {
  companyAlias,
  extractTickers,
  mentionMatcher,
  mentions,
  normalizeSymbol,
  TickerDirectory,
} from './tickers.js';
export * from './tool.js';
export type * from './types.js';
export { clampLimit, escapeRegExp, isoDay, padCik, weekdaysBack } from './util.js';

/** Body excerpt kept per story when `news({ read })` is requested (chars). */
export const MAX_BODY_CHARS = 2000;

export interface MarketsDeps {
  /** The pipeline's Fetcher (lazy — components are built on first use). */
  fetcher: () => Promise<Fetcher>;
  /** The page-cache SQLite handle for the TTL cache table (optional; memory-only without it). */
  db?: () => Promise<CacheDb | undefined>;
  policy: MarketsPolicy;
  contactEmail?: string;
  logger?: Logger;
  /** Read one article body (robots-respecting) — wired to `WebVector.fetch`; used by `news({ read })`. */
  readPage?: (url: string, signal?: AbortSignal) => Promise<string | undefined>;
}

export interface NewsReadOptions extends NewsOptions {
  /** Also fetch the body of the first N readable stories (0–3). */
  read?: number;
  /** Extra gate for body reads (e.g. the MCP server's domain allow/block lists). */
  canRead?: (url: string) => boolean;
}

/** Facade over the markets module for one WebVector instance (`wv.markets`). */
export class Markets {
  readonly cache: MarketsCache;
  readonly client: MarketsClient;
  readonly tickers: TickerDirectory;

  constructor(private readonly deps: MarketsDeps) {
    this.cache = new MarketsCache(deps.db);
    this.client = new MarketsClient({
      fetcher: deps.fetcher,
      cache: this.cache,
      policy: deps.policy,
      contactEmail: deps.contactEmail,
      logger: deps.logger,
    });
    this.tickers = new TickerDirectory(this.client);
  }

  get policy(): MarketsPolicy {
    return this.client.policy;
  }

  /** Headlines for symbols / a query / the whole market; `read` attaches the first N bodies. */
  async news(opts: NewsReadOptions = {}): Promise<NewsResult> {
    const res = await getNews(this.client, this.tickers, opts);
    const readPage = this.deps.readPage;
    const n = Math.min(opts.read ?? 0, 3);
    if (n > 0 && readPage) {
      // Google News links are opaque redirect ids — not readable without JS.
      // `canRead` sees the URL the fetcher will actually contact (redirect wrappers unwrapped).
      const readable = res.items.filter(
        (it) =>
          it.url &&
          !/news\.google\.com\//.test(it.url) &&
          (opts.canRead?.(cleanUrl(it.url).url) ?? true),
      );
      await Promise.all(
        readable.slice(0, n).map(async (it) => {
          try {
            const body = await readPage(it.url, opts.signal);
            if (body) it.body = body.slice(0, MAX_BODY_CHARS);
          } catch {
            /* body is optional */
          }
        }),
      );
    }
    return res;
  }

  filings(opts: FilingsOptions): Promise<FilingsResult> {
    return getFilings(this.client, this.tickers, opts);
  }

  searchFilings(opts: FilingSearchOptions): Promise<FilingsResult> {
    return searchFilings(this.client, this.tickers, opts);
  }

  calendar(opts: CalendarOptions = {}): Promise<CalendarResult> {
    return getCalendar(this.client, opts);
  }

  sentiment(opts: SentimentOptions): Promise<SentimentSnapshot> {
    return getSentiment(this.client, opts);
  }

  pulse(opts: PulseOptions = {}): Promise<PulseResult> {
    return getPulse(this.client, opts);
  }

  /** Catalog with the effective enabled/disabled state under the current policy. */
  status(): (MarketSource & { enabled: boolean; reason?: string })[] {
    return MARKET_SOURCES.map((s) => ({
      ...s,
      enabled: this.client.enabled(s).ok,
      reason: this.client.enabled(s).reason,
    }));
  }
}
