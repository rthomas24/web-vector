/**
 * Public types for the `markets` module — news, filings, calendars, sentiment and market pulse
 * for trading/research agents. Everything here is plain data so it can be rendered, cached and
 * returned through MCP `structuredContent` without transformation.
 */

/**
 * How freely a source may be used:
 * - `open`  — documented public API/feed, robots.txt allows the path (SEC EDGAR, CBOE, FRED, Fed…).
 * - `feed`  — an RSS/Atom feed or public JSON endpoint published for subscription; the host's
 *             robots.txt targets page crawlers (`Disallow: /` on a feeds-only host). Fetched with the
 *             robots check skipped for that request (`markets.feedRobots: 'exempt'`, the default).
 * - `gray`  — works keyless but robots.txt, terms, or a browser-UA requirement argue against
 *             automated use (Google News RSS, Nasdaq RSS/API, Yahoo chart API). Off unless
 *             `markets.graySources: true`.
 */
export type SourcePolicy = 'open' | 'feed' | 'gray';

export type SourceKind = 'news' | 'filings' | 'calendar' | 'sentiment' | 'market' | 'reference';

/** The policy switches a source's availability depends on (a subset of the `markets` config). */
export interface MarketsPolicyLike {
  graySources: boolean;
  feedRobots: 'exempt' | 'respect';
  disableSources: string[];
}

/** Parameters a per-ticker / per-query source URL is built from. */
export interface SourceUrlParams {
  symbol?: string;
  /** Short company name for query-style sources ("apple"). */
  alias?: string;
  query?: string;
}

export interface MarketSource {
  /** Stable id (`yahoo-rss`, `sec-submissions`, …) — used in `markets.disableSources` and results. */
  id: string;
  name: string;
  kind: SourceKind;
  policy: SourcePolicy;
  /** Host(s) contacted; `minIntervalMs` is applied to each. */
  hosts: string[];
  /** Fixed URL (market-wide feeds) or a builder for per-ticker / per-query sources. */
  url?: string | ((p: SourceUrlParams) => string);
  /** Per-ticker source (needs a symbol) vs market-wide. */
  perTicker: boolean;
  /** Cache lifetime for one response (ms). */
  ttlMs: number;
  /** Minimum spacing between requests to the source's hosts (ms), on top of the fetcher default. */
  minIntervalMs?: number;
  /** Relative trust for ranking/dedupe (0–1). */
  trust: number;
  /** Why it is classified the way it is (shown by `markets.status()` and in docs). */
  notes: string;
  /** Extra request headers (e.g. `accept: application/json`). */
  headers?: Record<string, string>;
  /**
   * User-Agent to send: `declared` = `WebVector/<ver> (<contact>)` (SEC fair-access form, no URL);
   * `browser` = browser-like UA (Akamai fronts that hang on unknown agents — gray by definition);
   * default = the fetcher's honest UA.
   */
  ua?: 'declared' | 'browser';
}

export type EventTag =
  | 'earnings'
  | 'guidance'
  | 'ma'
  | 'fda'
  | 'analyst'
  | 'insider'
  | 'offering'
  | 'legal'
  | 'macro'
  | 'product'
  | 'exec'
  | 'dividend'
  | 'buyback'
  | 'contract'
  | 'other';

export interface NewsItem {
  /** Stable id: hash of canonical URL (or title when no URL). */
  id: string;
  title: string;
  url: string;
  /** Source id that produced the item (`yahoo-rss`, `bing-news`, …). */
  source: string;
  /** Publisher/site name when the feed declares one (e.g. "Reuters", "GlobeNewswire"). */
  publisher?: string;
  /** ISO timestamp (feed pubDate / updated). */
  publishedAt?: string;
  /** Plain-text summary (tags stripped), trimmed. */
  summary?: string;
  /** Tickers the item is about (from the query symbol, cashtags, "(NASDAQ: X)" patterns). */
  tickers: string[];
  event: EventTag;
  /** How many distinct sources carried the same story (1 = single source). */
  spread: number;
  /** Other source ids that carried the story (when spread > 1). */
  alsoIn?: string[];
  /** Extracted article body (only when `read` was requested; capped). */
  body?: string;
}

export interface SourceRun {
  id: string;
  status: 'ok' | 'cached' | 'stale' | 'failed' | 'skipped' | 'timeout';
  /** Items contributed before dedupe. */
  count: number;
  ms?: number;
  /** Failure / skip reason, or `"n/m failed"` for a partially failed source. */
  reason?: string;
}

export interface NewsResult {
  symbols: string[];
  query?: string;
  /** Window start (ISO). */
  since: string;
  items: NewsItem[];
  sources: SourceRun[];
  /** Items before dedupe/filtering. */
  rawCount: number;
  fetchedAt: string;
}

export interface Filing {
  form: string;
  filedAt: string;
  /** Period of report when the filing declares one. */
  reportDate?: string;
  /** Acceptance timestamp when available (ISO, ET on EDGAR). */
  acceptedAt?: string;
  accession: string;
  /** Primary document URL on www.sec.gov/Archives (robots-allowed, fetchable with webvector_fetch). */
  url: string;
  /** Filing index page. */
  indexUrl: string;
  description?: string;
  /** 8-K item codes as filed (`2.02`, `5.02`, …). */
  items?: string[];
  /** Human labels for `items`. */
  itemLabels?: string[];
  size?: number;
  company: string;
  cik: string;
  ticker?: string;
  /** Tag derived from form type / items. */
  event: EventTag;
}

export interface FilingsResult {
  company?: { name: string; cik: string; tickers: string[]; exchanges: string[]; sic?: string };
  query?: string;
  filings: Filing[];
  /** Total matching filings reported by EDGAR full-text search (query mode). */
  total?: number;
  source: string;
  fetchedAt: string;
  fromCache: boolean;
}

export interface FilingHit extends Filing {
  /** Document id inside the filing (exhibit) when the hit is an exhibit. */
  docId?: string;
  score?: number;
}

export type Impact = 'high' | 'medium' | 'low';

export interface CalendarEvent {
  /** ISO timestamp (with offset). */
  time: string;
  title: string;
  /** ISO currency code used by the calendar (`USD`, `EUR`, …). */
  country: string;
  impact: Impact;
  forecast?: string;
  previous?: string;
  actual?: string;
  source: string;
}

export interface CalendarResult {
  from: string;
  to: string;
  events: CalendarEvent[];
  /** Recent central-bank press releases (Fed) within the lookback window. */
  fed?: { title: string; url: string; publishedAt?: string }[];
  /** Earnings calendar rows (only when a gray source provides them). */
  earnings?: EarningsRow[];
  sources: SourceRun[];
  fetchedAt: string;
}

export interface EarningsRow {
  date: string;
  symbol: string;
  name?: string;
  /** `bmo` (before market open), `amc` (after market close) or `tns` (time not supplied). */
  time?: 'bmo' | 'amc' | 'tns';
  epsEstimate?: string;
  marketCap?: string;
  source: string;
}

export interface SentimentSnapshot {
  symbol: string;
  source: string;
  /** Window covered by the sampled messages (ISO). */
  window: { from?: string; to?: string };
  messages: number;
  bullish: number;
  bearish: number;
  unlabeled: number;
  /** bullish / (bullish + bearish), undefined when nothing is labelled. */
  bullRatio?: number;
  /** Messages per hour over the sampled window. */
  messagesPerHour?: number;
  watchers?: number;
  top: {
    at: string;
    body: string;
    sentiment?: 'bullish' | 'bearish';
    likes?: number;
    user?: string;
  }[];
  /** FINRA daily short-sale volume for the latest available session. */
  shortVolume?: {
    date: string;
    shortVolume: number;
    totalVolume: number;
    /** shortVolume / totalVolume. */
    ratio: number;
    source: string;
  };
  sources: SourceRun[];
  fetchedAt: string;
}

export interface QuoteSnapshot {
  symbol: string;
  name?: string;
  price: number;
  prevClose?: number;
  changePct?: number;
  dayHigh?: number;
  dayLow?: number;
  volume?: number;
  /** ISO of the last trade/observation. */
  asOf?: string;
  currency?: string;
  source: string;
}

export interface SeriesPoint {
  date: string;
  value: number;
}

export interface SeriesSnapshot {
  id: string;
  label: string;
  last: SeriesPoint;
  prev?: SeriesPoint;
  change?: number;
  source: string;
  unit?: string;
}

export interface PulseResult {
  quotes: QuoteSnapshot[];
  series: SeriesSnapshot[];
  sources: SourceRun[];
  fetchedAt: string;
}

export interface TickerRecord {
  ticker: string;
  cik: string;
  name: string;
  exchange?: string;
}
