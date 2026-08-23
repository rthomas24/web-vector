/**
 * Event calendar: scheduled macro prints (CPI, NFP, FOMC…) from the lightweight JSON feed
 * Forex Factory publishes for automation, recent Federal Reserve press releases, and — when the
 * gray Nasdaq source is enabled — the earnings calendar for the next few sessions.
 */

import { cleanField } from '../ingest/parsers.js';
import { isNotFound, type MarketsClient, runSources, type SourceTask } from './client.js';
import { parseFeed } from './feed.js';
import { marketSource, sourceUrl } from './sources.js';
import { normalizeSymbol } from './tickers.js';
import type { CalendarEvent, CalendarResult, EarningsRow, Impact } from './types.js';
import { isoDay } from './util.js';

export interface CalendarOptions {
  /** Days ahead (default 3, max 14). */
  days?: number;
  /** Minimum impact to include (default medium). */
  impact?: Impact;
  /** Currency codes (FF convention: USD, EUR, GBP, JPY…; default ['USD']; ['ALL'] for everything). */
  countries?: string[];
  /** Include recent Fed press releases (default true). */
  fed?: boolean;
  /** Earnings rows — only with the gray Nasdaq source; filtered to these symbols when given. */
  earnings?: boolean;
  symbols?: string[];
  deadlineMs?: number;
  signal?: AbortSignal;
  now?: number;
}

interface FfRow {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast?: string;
  previous?: string;
  actual?: string;
}

const FF_THIS = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FF_NEXT = 'https://nfs.faireconomy.media/ff_calendar_nextweek.json';
const IMPACT_RANK: Record<Impact, number> = { high: 3, medium: 2, low: 1 };
/** Today's prints that already happened are still useful (with actuals). */
const LOOKBACK_MS = 12 * 3_600_000;

function mapImpact(v: string | undefined): Impact {
  const s = (v ?? '').toLowerCase();
  return s.startsWith('hi') ? 'high' : s.startsWith('med') ? 'medium' : 'low';
}

/** Parse Forex Factory JSON rows into calendar events (exported for tests). */
export function parseFfCalendar(rows: FfRow[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const r of rows ?? []) {
    const t = Date.parse(r.date);
    if (!Number.isFinite(t) || !r.title) continue;
    out.push({
      time: new Date(t).toISOString(),
      title: cleanField(String(r.title), 160) ?? '',
      country: String(r.country ?? '').toUpperCase(),
      impact: mapImpact(r.impact),
      forecast: r.forecast || undefined,
      previous: r.previous || undefined,
      actual: r.actual || undefined,
      source: 'ff-calendar',
    });
  }
  return out;
}

interface NasdaqEarnings {
  data?: {
    rows?: {
      symbol: string;
      name?: string;
      time?: string;
      epsForecast?: string;
      marketCap?: string;
    }[];
  };
}

function mapTime(t?: string): EarningsRow['time'] {
  if (!t) return undefined;
  return /pre/i.test(t) ? 'bmo' : /after/i.test(t) ? 'amc' : 'tns';
}

const parseCap = (s?: string) => Number((s ?? '').replace(/[^0-9.]/g, '')) || 0;

export async function getCalendar(
  client: MarketsClient,
  opts: CalendarOptions = {},
): Promise<CalendarResult> {
  const now = opts.now ?? Date.now();
  const days = Math.max(1, Math.min(opts.days ?? 3, 14));
  const from = now - LOOKBACK_MS;
  const to = now + days * 86_400_000;
  const minRank = IMPACT_RANK[opts.impact ?? 'medium'];
  const countries = (opts.countries?.length ? opts.countries : ['USD']).map((c) => c.toUpperCase());
  const all = countries.includes('ALL');
  const symbols = new Set((opts.symbols ?? []).map(normalizeSymbol));

  let events: CalendarEvent[] = [];
  let fed: CalendarResult['fed'];
  let earnings: EarningsRow[] | undefined;
  const tasks: SourceTask[] = [];

  const ff = marketSource('ff-calendar');
  tasks.push({
    source: ff,
    run: async (signal) => {
      // This week's file runs Sunday evening → Saturday (ET); next week's appears late in the week
      // (404 until then — remembered briefly so it is not re-probed on every call).
      const missKey = `${ff.id} ${FF_NEXT}`;
      const [thisWeek, nextWeek] = await Promise.all([
        client.fetchJson<FfRow[]>(ff, FF_THIS, { signal }),
        (await client.opts.cache.isMissing(missKey, now))
          ? undefined
          : client.fetchJson<FfRow[]>(ff, FF_NEXT, { signal }).catch(async (err) => {
              if (isNotFound(err)) await client.opts.cache.markMissing(missKey, 3_600_000, now);
              return undefined;
            }),
      ]);
      events = parseFfCalendar([...thisWeek.data, ...(nextWeek?.data ?? [])]);
      return { count: events.length, fromCache: thisWeek.fromCache, stale: thisWeek.stale };
    },
  });

  if (opts.fed !== false) {
    const src = marketSource('fed-press');
    tasks.push({
      source: src,
      run: async (signal) => {
        const url = sourceUrl(src);
        const r = await client.fetchText(src, url, { signal });
        fed = parseFeed(r.text, url)
          .items.filter((i) => !i.publishedAt || Date.parse(i.publishedAt) >= now - 7 * 86_400_000)
          .slice(0, 6)
          .map((i) => ({ title: i.title, url: i.link ?? '', publishedAt: i.publishedAt }));
        return { count: fed.length, fromCache: r.fromCache, stale: r.stale };
      },
    });
  }

  if (opts.earnings !== false) {
    const src = marketSource('nasdaq-earnings');
    tasks.push({
      source: src,
      run: async (signal) => {
        const dates: string[] = [];
        for (let d = 0; d < Math.min(days, 5); d++) {
          const t = now + d * 86_400_000;
          const dow = new Date(t).getUTCDay();
          if (dow !== 0 && dow !== 6) dates.push(isoDay(t));
        }
        // Days in parallel; the host queue paces them. A single bad day does not void the rest.
        type Day = { date: string; data: NasdaqEarnings; fromCache: boolean };
        const results = await Promise.allSettled(
          dates.map(
            (date): Promise<Day> =>
              client
                .fetchJson<NasdaqEarnings>(
                  src,
                  `https://api.nasdaq.com/api/calendar/earnings?date=${date}`,
                  { signal },
                )
                .then((r) => ({ date, data: r.data, fromCache: r.fromCache })),
          ),
        );
        const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
        if (!ok.length) throw (results[0] as PromiseRejectedResult).reason;
        const rows: EarningsRow[] = [];
        for (const { date, data } of ok)
          for (const row of data.data?.rows ?? []) {
            const symbol = normalizeSymbol(row.symbol);
            if (symbols.size && !symbols.has(symbol)) continue;
            rows.push({
              date,
              symbol,
              name: cleanField(row.name, 120),
              time: mapTime(row.time),
              epsEstimate: row.epsForecast || undefined,
              marketCap: row.marketCap || undefined,
              source: src.id,
            });
          }
        if (!symbols.size) rows.sort((a, b) => parseCap(b.marketCap) - parseCap(a.marketCap));
        earnings = rows.slice(0, symbols.size ? 100 : 40);
        return { count: rows.length, fromCache: ok.every((r) => r.fromCache) };
      },
    });
  }

  const sources = await runSources(client, tasks, {
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
  });
  const seen = new Set<string>();
  events = events
    .filter((e) => {
      const t = Date.parse(e.time);
      const key = `${e.time}|${e.country}|${e.title}`;
      if (
        t < from ||
        t > to ||
        (!all && !countries.includes(e.country)) ||
        IMPACT_RANK[e.impact] < minRank ||
        seen.has(key)
      )
        return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    events,
    fed,
    earnings,
    sources,
    fetchedAt: new Date(now).toISOString(),
  };
}
