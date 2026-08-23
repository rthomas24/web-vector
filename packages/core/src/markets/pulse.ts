/**
 * Market pulse: the handful of numbers a trading agent wants before sizing anything — VIX (Cboe
 * CSV), Treasury yields / fed funds (FRED CSV) and, when the gray Yahoo chart API is enabled,
 * index ETFs, futures proxies and any requested symbols. Open sources only by default; the result
 * says which sources were skipped so the agent can fall back to its broker for quotes.
 */

import { cleanField } from '../ingest/parsers.js';
import { type MarketsClient, runSources, type SourceTask } from './client.js';
import { marketSource, sourceUrl } from './sources.js';
import { normalizeSymbol } from './tickers.js';
import type { PulseResult, QuoteSnapshot, SeriesPoint, SeriesSnapshot } from './types.js';
import { isoDay } from './util.js';

export interface PulseOptions {
  /** Extra symbols for the (gray) Yahoo chart source. */
  symbols?: string[];
  /** FRED series ids (default DGS10, DGS2, DFF). */
  fredSeries?: string[];
  /** Include the default index/futures basket from Yahoo when enabled (default true). */
  basket?: boolean;
  deadlineMs?: number;
  signal?: AbortSignal;
  now?: number;
}

export const DEFAULT_BASKET = [
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  '^VIX',
  '^TNX',
  'CL=F',
  'GC=F',
  'DX-Y.NYB',
  'BTC-USD',
];
const DEFAULT_FRED = ['DGS10', 'DGS2', 'DFF'];
const FRED_LABELS: Record<string, string> = {
  DGS10: '10Y Treasury yield',
  DGS2: '2Y Treasury yield',
  DGS30: '30Y Treasury yield',
  DFF: 'Effective fed funds rate',
  T10Y2Y: '10Y–2Y spread',
  T10Y3M: '10Y–3M spread',
  DTWEXBGS: 'Trade-weighted dollar index',
  VIXCLS: 'VIX close',
  DCOILWTICO: 'WTI crude',
};

function series(
  points: SeriesPoint[],
  meta: { id: string; label: string; source: string; unit?: string; digits: number },
): SeriesSnapshot | undefined {
  const last = points[points.length - 1];
  if (!last) return undefined;
  const prev = points.length > 1 ? points[points.length - 2] : undefined;
  return {
    ...meta,
    last,
    prev,
    change: prev ? Number((last.value - prev.value).toFixed(meta.digits)) : undefined,
  };
}

/** Last observations of a FRED-style CSV (`observation_date,VALUE`; missing = '.'). */
export function parseFredCsv(csv: string, id: string): SeriesSnapshot | undefined {
  const points: SeriesPoint[] = [];
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [date, v] = line.split(',');
    const n = Number(v);
    if (date && v && v !== '.' && Number.isFinite(n)) points.push({ date, value: n });
  }
  return series(points, {
    id,
    label: FRED_LABELS[id] ?? id,
    source: 'fred',
    unit: /^(DGS|DFF|T10Y)/.test(id) ? '%' : undefined,
    digits: 4,
  });
}

/** Last rows of the Cboe VIX history CSV (`DATE,OPEN,HIGH,LOW,CLOSE`, MM/DD/YYYY) — reads only the tail. */
export function parseVixCsv(csv: string): SeriesSnapshot | undefined {
  const trimmed = csv.trimEnd();
  let cut = trimmed.length;
  for (let i = 0; i < 5 && cut > 0; i++) cut = trimmed.lastIndexOf('\n', cut - 1);
  const points: SeriesPoint[] = [];
  for (const line of trimmed.slice(cut + 1).split('\n')) {
    const cols = line.split(',');
    const close = Number(cols[4]);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((cols[0] ?? '').trim());
    if (m && Number.isFinite(close)) points.push({ date: `${m[3]}-${m[1]}-${m[2]}`, value: close });
  }
  return series(points, { id: 'VIX', label: 'Cboe VIX (close)', source: 'cboe-vix', digits: 2 });
}

interface YahooChart {
  chart?: {
    result?: {
      meta?: {
        symbol?: string;
        shortName?: string;
        longName?: string;
        currency?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketDayHigh?: number;
        regularMarketDayLow?: number;
        regularMarketVolume?: number;
        regularMarketTime?: number;
      };
    }[];
  };
}

const positive = (n?: number) => (typeof n === 'number' && n > 0 ? n : undefined);

export function parseYahooChart(data: YahooChart, symbol: string): QuoteSnapshot | undefined {
  const meta = data.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return undefined;
  const prev = positive(meta.chartPreviousClose ?? meta.previousClose);
  return {
    symbol: cleanField(meta.symbol, 20) ?? symbol,
    name: cleanField(meta.shortName ?? meta.longName, 80),
    price: meta.regularMarketPrice,
    prevClose: prev,
    changePct: prev
      ? Number((((meta.regularMarketPrice - prev) / prev) * 100).toFixed(2))
      : undefined,
    dayHigh: positive(meta.regularMarketDayHigh),
    dayLow: positive(meta.regularMarketDayLow),
    volume: positive(meta.regularMarketVolume),
    asOf: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : undefined,
    currency: meta.currency,
    source: 'yahoo-chart',
  };
}

export async function getPulse(
  client: MarketsClient,
  opts: PulseOptions = {},
): Promise<PulseResult> {
  const now = opts.now ?? Date.now();
  const seriesOut: SeriesSnapshot[] = [];
  const quotes: QuoteSnapshot[] = [];
  const vix = marketSource('cboe-vix');
  const fred = marketSource('fred');
  const yahoo = marketSource('yahoo-chart');
  const textTask = (
    source: typeof vix,
    url: string,
    parse: (text: string) => SeriesSnapshot | undefined,
  ): SourceTask => ({
    source,
    run: async (signal) => {
      const r = await client.fetchText(source, url, { signal });
      const s = parse(r.text);
      if (s) seriesOut.push(s);
      return { count: s ? 1 : 0, fromCache: r.fromCache, stale: r.stale };
    },
  });
  const tasks: SourceTask[] = [textTask(vix, sourceUrl(vix), parseVixCsv)];
  const cosd = isoDay(now - 45 * 86_400_000);
  for (const id of opts.fredSeries ?? DEFAULT_FRED)
    tasks.push(
      textTask(
        fred,
        `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${cosd}`,
        (t) => parseFredCsv(t, id),
      ),
    );
  const symbols = [
    ...new Set([
      ...(opts.basket !== false ? DEFAULT_BASKET : []),
      ...(opts.symbols ?? []).map(normalizeSymbol),
    ]),
  ];
  for (const symbol of symbols)
    tasks.push({
      source: yahoo,
      run: async (signal) => {
        const r = await client.fetchJson<YahooChart>(yahoo, sourceUrl(yahoo, { symbol }), {
          signal,
        });
        const q = parseYahooChart(r.data, symbol);
        if (q) quotes.push(q);
        return { count: q ? 1 : 0, fromCache: r.fromCache, stale: r.stale };
      },
    });
  const sources = await runSources(client, tasks, {
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
  });
  const order = new Map(symbols.map((s, i) => [s, i]));
  quotes.sort((a, b) => (order.get(a.symbol) ?? 99) - (order.get(b.symbol) ?? 99));
  return { quotes, series: seriesOut, sources, fetchedAt: new Date(now).toISOString() };
}
