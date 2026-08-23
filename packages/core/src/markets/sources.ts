/**
 * Source catalog for the markets module. Every entry was probed live (2026-08-22/23, US IP,
 * honest `WebVector/<ver>` UA) and classified by how freely it may be used:
 *
 *   open  documented public API/feed + robots.txt allows the path
 *   feed  syndication endpoint (RSS/Atom/JSON published for readers); the host's robots.txt
 *         targets page crawlers (`Disallow: /` on a feeds-only host) — fetched with the robots
 *         check skipped for that request, everything else (SSRF, pacing, bot-wall detection) on
 *   gray  keyless but robots/ToS/browser-UA requirement argue against automation — opt-in only
 *
 * The catalog is the single place that knows a source's URL(s), host pacing, UA requirement and
 * policy; the client derives request behaviour from it (`robotsModeFor`). Known-hostile hosts
 * (Reuters, Bloomberg, Dow Jones pages, FT, Seeking Alpha articles, TradingView, Zacks, Stooq,
 * CME, Investing.com HTML, Business Wire www, Accesswire, Reddit JSON) are deliberately absent.
 * Article *bodies* are only ever read through the normal pipeline (`WebVector.fetch`), which
 * honours robots.txt — a headline from a Dow Jones feed can be shown but the page is never scraped.
 */
import type { MarketSource, MarketsPolicyLike, SourceUrlParams } from './types.js';

const enc = encodeURIComponent;

export const MARKET_SOURCES: readonly MarketSource[] = [
  // ─── per-ticker news feeds ───────────────────────────────────────────────
  {
    id: 'yahoo-rss',
    name: 'Yahoo Finance headlines (RSS)',
    kind: 'news',
    policy: 'feed',
    hosts: ['feeds.finance.yahoo.com'],
    url: ({ symbol }) =>
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${enc(symbol ?? '')}&region=US&lang=en-US`,
    perTicker: true,
    ttlMs: 300_000,
    trust: 0.7,
    notes:
      'Per-ticker syndication feed (max-age=300). The feeds host robots.txt is a blanket Disallow aimed at crawlers; treated as a feed. Carries loosely related items, so results are filtered to stories that mention the company.',
  },
  {
    id: 'seekingalpha-rss',
    name: 'Seeking Alpha symbol feed (RSS)',
    kind: 'news',
    policy: 'feed',
    hosts: ['seekingalpha.com'],
    url: ({ symbol }) => `https://seekingalpha.com/api/sa/combined/${enc(symbol ?? '')}.xml`,
    perTicker: true,
    ttlMs: 180_000,
    trust: 0.65,
    notes:
      'Headlines only (articles are paywalled and never fetched). Path is allowed for `*`; the feed is marked personal-use by SA.',
  },
  {
    id: 'bing-news',
    name: 'Bing News (RSS)',
    kind: 'news',
    policy: 'open',
    hosts: ['www.bing.com'],
    url: ({ symbol, alias, query }) =>
      `https://www.bing.com/news/search?q=${enc(query ?? (alias ? `${alias} ${symbol}` : `${symbol} stock`))}&format=rss`,
    perTicker: true,
    ttlMs: 300_000,
    minIntervalMs: 1000,
    trust: 0.55,
    notes:
      'Keyword news, ~10–14 items; links are apiclick redirectors (unwrapped). robots.txt disallows /search but not /news/search; personal-use per Microsoft notice; ≤1 req/s.',
  },
  {
    id: 'google-news',
    name: 'Google News (RSS)',
    kind: 'news',
    policy: 'gray',
    hosts: ['news.google.com'],
    url: ({ symbol, alias, query }) =>
      `https://news.google.com/rss/search?q=${enc(query ?? (alias ? `"${alias}" OR ${symbol} when:7d` : `${symbol} stock when:7d`))}&hl=en-US&gl=US&ceid=US:en`,
    perTicker: true,
    ttlMs: 300_000,
    minIntervalMs: 2000,
    trust: 0.6,
    notes:
      'Best keyless catalyst finder, but /rss is not in the robots allowlist and the feed licence says personal, non-commercial. Links are opaque redirect ids (bodies are not read).',
  },
  {
    id: 'nasdaq-rss',
    name: 'Nasdaq.com symbol news (RSS)',
    kind: 'news',
    policy: 'gray',
    hosts: ['www.nasdaq.com'],
    url: ({ symbol }) => `https://www.nasdaq.com/feed/rssoutbound?symbol=${enc(symbol ?? '')}`,
    perTicker: true,
    ttlMs: 600_000,
    minIntervalMs: 30_000,
    trust: 0.7,
    ua: 'browser',
    notes:
      'Includes press releases; Akamai hangs on non-browser UAs and robots.txt sets Crawl-delay: 30 (honoured per host), so gray.',
  },
  // ─── market-wide feeds (filtered by ticker mention when a symbol is given) ─
  {
    id: 'cnbc-top',
    name: 'CNBC Top News (RSS)',
    kind: 'news',
    policy: 'open',
    hosts: ['www.cnbc.com'],
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    perTicker: false,
    ttlMs: 120_000,
    trust: 0.75,
    notes: 'Headlines + summaries (ttl 60).',
  },
  {
    id: 'marketwatch-realtime',
    name: 'MarketWatch real-time headlines (RSS)',
    kind: 'news',
    policy: 'open',
    hosts: ['feeds.content.dowjones.io'],
    url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines',
    perTicker: false,
    ttlMs: 120_000,
    trust: 0.75,
    notes: 'Public Dow Jones feed. marketwatch.com pages are never fetched (robots Disallow: /).',
  },
  {
    id: 'marketwatch-bulletins',
    name: 'MarketWatch bulletins (RSS)',
    kind: 'news',
    policy: 'open',
    hosts: ['feeds.content.dowjones.io'],
    url: 'https://feeds.content.dowjones.io/public/rss/mw_bulletins',
    perTicker: false,
    ttlMs: 120_000,
    trust: 0.75,
    notes: 'Breaking bulletins.',
  },
  {
    id: 'benzinga',
    name: 'Benzinga (RSS)',
    kind: 'news',
    policy: 'open',
    hosts: ['www.benzinga.com'],
    url: 'https://www.benzinga.com/feed',
    perTicker: false,
    ttlMs: 300_000,
    trust: 0.55,
    notes: 'WordPress firehose (~300 KB, ETag). Categories carry tickers.',
  },
  {
    id: 'globenewswire-public',
    name: 'GlobeNewswire — public companies (RSS)',
    kind: 'news',
    policy: 'open',
    hosts: ['www.globenewswire.com'],
    url: 'https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies',
    perTicker: false,
    ttlMs: 120_000,
    trust: 0.8,
    notes:
      'Last 20 press releases from public companies (earnings, guidance, M&A). /RssFeed/ is allowed; release pages are allowed.',
  },
  {
    id: 'prnewswire-financial',
    name: 'PR Newswire — financial services (RSS)',
    kind: 'news',
    policy: 'open',
    hosts: ['www.prnewswire.com'],
    url: 'https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss',
    perTicker: false,
    ttlMs: 120_000,
    trust: 0.75,
    notes: 'Wire releases (ETag, max-age=60).',
  },
  {
    id: 'fed-press',
    name: 'Federal Reserve press releases (RSS)',
    kind: 'news',
    policy: 'open',
    hosts: ['www.federalreserve.gov'],
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    perTicker: false,
    ttlMs: 600_000,
    trust: 0.95,
    notes: 'Statements, minutes, speeches (no robots.txt).',
  },
  // ─── filings ──────────────────────────────────────────────────────────────
  {
    id: 'sec-submissions',
    name: 'SEC EDGAR submissions API',
    kind: 'filings',
    policy: 'open',
    hosts: ['data.sec.gov'],
    perTicker: true,
    ttlMs: 300_000,
    trust: 1,
    ua: 'declared',
    headers: { accept: 'application/json' },
    notes:
      'data.sec.gov/submissions/CIK##########.json — filing history. SEC fair-access policy: declared User-Agent `Name (contact)`, ≤10 req/s (the fetcher paces per host).',
  },
  {
    id: 'sec-fulltext',
    name: 'SEC EDGAR full-text search',
    kind: 'filings',
    policy: 'open',
    hosts: ['efts.sec.gov'],
    perTicker: false,
    ttlMs: 300_000,
    trust: 1,
    ua: 'declared',
    headers: { accept: 'application/json' },
    notes: 'efts.sec.gov/LATEST/search-index?q=… — Elasticsearch over filings since 2001.',
  },
  {
    id: 'sec-tickers',
    name: 'SEC ticker ↔ CIK map',
    kind: 'reference',
    policy: 'open',
    hosts: ['www.sec.gov'],
    url: 'https://www.sec.gov/files/company_tickers_exchange.json',
    perTicker: false,
    ttlMs: 24 * 3_600_000,
    trust: 1,
    ua: 'declared',
    headers: { accept: 'application/json' },
    notes: 'Refreshed daily.',
  },
  // ─── calendar / macro ─────────────────────────────────────────────────────
  {
    id: 'ff-calendar',
    name: 'Economic calendar (Forex Factory JSON)',
    kind: 'calendar',
    policy: 'open',
    hosts: ['nfs.faireconomy.media'],
    perTicker: false,
    ttlMs: 300_000,
    trust: 0.85,
    headers: { accept: 'application/json' },
    notes:
      'nfs.faireconomy.media/ff_calendar_thisweek.json (+nextweek when published) — the lightweight feed Forex Factory publishes for automation (max-age=60, ETag): title, currency, time, impact, forecast, previous, actual.',
  },
  {
    id: 'nasdaq-earnings',
    name: 'Nasdaq earnings calendar (API)',
    kind: 'calendar',
    policy: 'gray',
    hosts: ['api.nasdaq.com'],
    perTicker: false,
    ttlMs: 3_600_000,
    minIntervalMs: 2000,
    trust: 0.8,
    ua: 'browser',
    headers: { accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9' },
    notes:
      'api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD — undocumented; requires a browser UA (Akamai). Gray.',
  },
  // ─── sentiment ────────────────────────────────────────────────────────────
  {
    id: 'stocktwits',
    name: 'StockTwits symbol stream',
    kind: 'sentiment',
    policy: 'open',
    hosts: ['api.stocktwits.com'],
    url: ({ symbol }) =>
      `https://api.stocktwits.com/api/2/streams/symbol/${enc(symbol ?? '')}.json`,
    perTicker: true,
    ttlMs: 120_000,
    minIntervalMs: 1000,
    trust: 0.5,
    headers: { accept: 'application/json' },
    notes: 'Public, keyless (~200 req/h/IP). Robots disallows query strings only.',
  },
  {
    id: 'finra-short-volume',
    name: 'FINRA daily short-sale volume',
    kind: 'sentiment',
    policy: 'open',
    hosts: ['cdn.finra.org'],
    perTicker: false,
    ttlMs: 6 * 3_600_000,
    trust: 1,
    notes:
      'cdn.finra.org/equity/regsho/daily/CNMSshvolYYYYMMDD.txt — consolidated NMS short volume per symbol (pipe-delimited, ~500 KB, published after the close).',
  },
  // ─── market pulse ─────────────────────────────────────────────────────────
  {
    id: 'cboe-vix',
    name: 'Cboe VIX history (CSV)',
    kind: 'market',
    policy: 'open',
    hosts: ['cdn.cboe.com'],
    url: 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv',
    perTicker: false,
    ttlMs: 900_000,
    trust: 1,
    notes: 'Daily OHLC (max-age=900).',
  },
  {
    id: 'fred',
    name: 'FRED series (CSV)',
    kind: 'market',
    policy: 'open',
    hosts: ['fred.stlouisfed.org'],
    perTicker: false,
    ttlMs: 3_600_000,
    minIntervalMs: 1000,
    trust: 1,
    notes:
      'fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES — keyless CSV; robots Crawl-delay: 1 honoured. One series per request (multi-id responses are zipped).',
  },
  {
    id: 'yahoo-chart',
    name: 'Yahoo Finance chart API',
    kind: 'market',
    policy: 'gray',
    hosts: ['query2.finance.yahoo.com'],
    url: ({ symbol }) =>
      `https://query2.finance.yahoo.com/v8/finance/chart/${enc(symbol ?? '')}?range=5d&interval=1d`,
    perTicker: true,
    ttlMs: 60_000,
    trust: 0.8,
    headers: { accept: 'application/json' },
    notes:
      'Keyless quotes/OHLC (no crumb), but robots Disallow: / and Yahoo terms; gray. Prefer your broker for quotes.',
  },
];

const byId = new Map(MARKET_SOURCES.map((s) => [s.id, s]));

export function marketSource(id: string): MarketSource {
  const s = byId.get(id);
  if (!s) throw new Error(`unknown market source: ${id}`);
  return s;
}

export function listMarketSources(kind?: MarketSource['kind']): MarketSource[] {
  return MARKET_SOURCES.filter((s) => !kind || s.kind === kind);
}

/** Resolve a source's URL (fixed or built from symbol/alias/query). */
export function sourceUrl(source: MarketSource, p: SourceUrlParams = {}): string {
  if (!source.url) throw new Error(`source ${source.id} has no catalog URL`);
  return typeof source.url === 'string' ? source.url : source.url(p);
}

/** Is this source usable under the policy? */
export function sourceEnabled(
  source: MarketSource,
  policy: MarketsPolicyLike,
): { ok: boolean; reason?: string } {
  if (policy.disableSources.includes(source.id))
    return { ok: false, reason: 'disabled by markets.disableSources' };
  if (source.policy === 'gray' && !policy.graySources)
    return { ok: false, reason: 'gray source (robots/terms) — enable with markets.graySources' };
  if (source.policy === 'feed' && policy.feedRobots === 'respect')
    return { ok: false, reason: 'feed on a crawler-blocking host (markets.feedRobots: respect)' };
  return { ok: true };
}

/**
 * robots.txt mode for a request: syndication feeds (policy `feed`) and operator-enabled gray
 * sources skip the check for that request; everything else respects it.
 */
export function robotsModeFor(source: MarketSource): 'respect' | 'skip' {
  return source.policy === 'open' ? 'respect' : 'skip';
}

/** Browser-like UA for the gray hosts that hang on unknown agents. */
export const MARKETS_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

export type { SourceUrlParams } from './types.js';
