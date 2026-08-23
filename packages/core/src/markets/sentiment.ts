/**
 * Crowd/positioning signals for one symbol: the StockTwits public symbol stream (bull/bear
 * tags, message velocity, watchers, most-liked posts) and FINRA's daily consolidated short-sale
 * volume (short volume / total volume for the latest published session). Both are keyless and
 * open; both are noisy — the renderer says so.
 */
import { cleanField } from '../ingest/parsers.js';
import { isNotFound, type MarketsClient, runSources, type SourceTask } from './client.js';
import { marketSource, sourceUrl } from './sources.js';
import { normalizeSymbol } from './tickers.js';
import type { SentimentSnapshot } from './types.js';
import { escapeRegExp, weekdaysBack } from './util.js';

export interface SentimentOptions {
  symbol: string;
  /** Top messages to keep (default 5). */
  top?: number;
  /** Include FINRA short volume (default true). */
  shortVolume?: boolean;
  deadlineMs?: number;
  signal?: AbortSignal;
  now?: number;
}

interface StMessage {
  id: number;
  body: string;
  created_at: string;
  user?: { username?: string };
  entities?: { sentiment?: { basic?: string } | null };
  likes?: { total?: number };
}
interface StStream {
  symbol?: { symbol?: string; title?: string; watchlist_count?: number };
  messages?: StMessage[];
}

type Tag = 'bullish' | 'bearish' | undefined;
const tagOf = (m: StMessage): Tag => {
  const s = m.entities?.sentiment?.basic?.toLowerCase();
  return s === 'bullish' || s === 'bearish' ? s : undefined;
};

/** Parse a StockTwits stream payload (exported for tests). */
export function summarizeStocktwits(
  data: StStream,
  symbol: string,
  top = 5,
): Omit<SentimentSnapshot, 'sources' | 'fetchedAt' | 'shortVolume'> {
  const msgs = data.messages ?? [];
  let bullish = 0;
  let bearish = 0;
  let from: number | undefined;
  let to: number | undefined;
  for (const m of msgs) {
    const tag = tagOf(m);
    if (tag === 'bullish') bullish++;
    else if (tag === 'bearish') bearish++;
    const t = Date.parse(m.created_at);
    if (Number.isFinite(t)) {
      from = from === undefined ? t : Math.min(from, t);
      to = to === undefined ? t : Math.max(to, t);
    }
  }
  const labelled = bullish + bearish;
  const hours =
    from !== undefined && to !== undefined ? Math.max((to - from) / 3_600_000, 1 / 60) : undefined;
  return {
    symbol,
    source: 'stocktwits',
    window: {
      from: from !== undefined ? new Date(from).toISOString() : undefined,
      to: to !== undefined ? new Date(to).toISOString() : undefined,
    },
    messages: msgs.length,
    bullish,
    bearish,
    unlabeled: msgs.length - labelled,
    bullRatio: labelled ? bullish / labelled : undefined,
    messagesPerHour: hours && msgs.length > 1 ? msgs.length / hours : undefined,
    watchers: data.symbol?.watchlist_count,
    top: [...msgs]
      .sort((a, b) => (b.likes?.total ?? 0) - (a.likes?.total ?? 0))
      .slice(0, top)
      .map((m) => ({
        at: new Date(Date.parse(m.created_at) || 0).toISOString(),
        body: cleanField(m.body, 240) ?? '',
        sentiment: tagOf(m),
        likes: m.likes?.total,
        user: cleanField(m.user?.username, 40),
      })),
  };
}

/** Parse one symbol's row out of a FINRA CNMSshvol file (exported for tests). */
export function finraShortRow(
  text: string,
  symbol: string,
): { date: string; shortVolume: number; totalVolume: number; ratio: number } | undefined {
  const m = new RegExp(
    `^(\\d{8})\\|${escapeRegExp(symbol)}\\|([\\d.]+)\\|[\\d.]*\\|([\\d.]+)\\|`,
    'm',
  ).exec(text);
  if (!m) return undefined;
  const shortVolume = Number(m[2]);
  const totalVolume = Number(m[3]);
  if (!Number.isFinite(shortVolume) || !Number.isFinite(totalVolume) || totalVolume <= 0)
    return undefined;
  const d = m[1] as string;
  return {
    date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
    shortVolume,
    totalVolume,
    ratio: shortVolume / totalVolume,
  };
}

const FINRA_URL = (yyyymmdd: string) =>
  `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${yyyymmdd}.txt`;

export async function getSentiment(
  client: MarketsClient,
  opts: SentimentOptions,
): Promise<SentimentSnapshot> {
  const now = opts.now ?? Date.now();
  const symbol = normalizeSymbol(opts.symbol);
  let base: ReturnType<typeof summarizeStocktwits> | undefined;
  let shortVolume: SentimentSnapshot['shortVolume'];
  const st = marketSource('stocktwits');
  const tasks: SourceTask[] = [
    {
      source: st,
      run: async (signal) => {
        const r = await client.fetchJson<StStream>(st, sourceUrl(st, { symbol }), { signal });
        base = summarizeStocktwits(r.data, symbol, opts.top ?? 5);
        return { count: base.messages, fromCache: r.fromCache, stale: r.stale };
      },
    },
  ];
  if (opts.shortVolume !== false) {
    const finra = marketSource('finra-short-volume');
    tasks.push({
      source: finra,
      run: async (signal) => {
        // Files post after the close; walk back from today, remembering dates that 404 so the
        // probe is not repeated on every call.
        let lastErr: unknown;
        for (const d of weekdaysBack(now, 6)) {
          const url = FINRA_URL(d);
          const key = `${finra.id} ${url}`;
          if (await client.opts.cache.isMissing(key, now)) continue;
          try {
            const r = await client.fetchText(finra, url, { signal });
            const row = finraShortRow(r.text, symbol);
            shortVolume = row ? { ...row, source: finra.id } : undefined;
            return { count: row ? 1 : 0, fromCache: r.fromCache, stale: r.stale };
          } catch (err) {
            lastErr = err;
            if (signal.aborted) throw err;
            if (isNotFound(err)) await client.opts.cache.markMissing(key, 30 * 60_000, now);
          }
        }
        throw lastErr ?? new Error('no FINRA file found');
      },
    });
  }
  const sources = await runSources(client, tasks, {
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
  });
  return {
    ...(base ?? {
      symbol,
      source: st.id,
      window: {},
      messages: 0,
      bullish: 0,
      bearish: 0,
      unlabeled: 0,
      top: [],
    }),
    shortVolume,
    sources,
    fetchedAt: new Date(now).toISOString(),
  };
}
