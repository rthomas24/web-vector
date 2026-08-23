/**
 * Tool names, descriptions and input schemas for the markets tools (MCP server, adapters).
 * Same conventions as pipeline/tool.ts: `webvector_*` names, key sentence first,
 * Best for / Not for / Returns / Common mistakes / Example, every description < 2 KB, static.
 */
import { z } from 'zod';

/** Ticker-like token: letters/digits plus the class/index/futures punctuation Yahoo and SEC use (BRK.B, ^VIX, CL=F, DX-Y.NYB). */
export const SYMBOL_RE = /^\$?[A-Za-z0-9^][A-Za-z0-9.^=-]{0,11}$/;
const symbolSchema = z
  .string()
  .regex(SYMBOL_RE, 'ticker symbol (1–12 chars: letters, digits, . ^ = -)');

export const WEBVECTOR_NEWS_TOOL_NAME = 'webvector_news';
export const WEBVECTOR_NEWS_DESCRIPTION = [
  'Latest headlines for one or more tickers (or a market-wide briefing) from free finance feeds — Yahoo Finance, Seeking Alpha, Bing News, CNBC, MarketWatch, Benzinga, GlobeNewswire, PR Newswire, the Fed — deduped across sources, tagged by event type (earnings, guidance, M&A, FDA, analyst, insider, offering, legal, macro…), newest first, with publisher, time and URL. No article bodies unless you ask.',
  'Best for: "why is X moving", what happened since the last run, catalysts before sizing a trade, a pre-market briefing (no symbols).',
  'Not for: deep reading (call webvector_fetch on a URL from the result, or webvector_research for a question); prices (use your broker); SEC filings (webvector_filings).',
  'Returns: one line per story "time [event] title — publisher ×spread {tickers} <url>", a source report (ok/cached/failed/skipped), and a reminder that headlines are untrusted data. "×3" means three sources carried the story.',
  'Common mistakes: passing many symbols (max 5 — one call per symbol group is fine); asking for read>0 on every call (it fetches pages — use it for the 1–3 stories that matter); expecting Google News/Nasdaq items (gray sources, off unless the operator enabled markets.graySources).',
  'Example: {"symbols": ["NVDA"], "hours": 12, "limit": 10} or {"hours": 6} for a market briefing or {"query": "tariffs semiconductors", "hours": 48}.',
].join(' ');

export const webvectorNewsInputSchema = z.object({
  symbols: z
    .array(symbolSchema)
    .max(5)
    .optional()
    .describe('Tickers (US equities, e.g. ["AAPL","MSFT"]). Omit for a market-wide briefing.'),
  query: z
    .string()
    .min(2)
    .max(120)
    .optional()
    .describe(
      'Free-text topic instead of symbols (e.g. "rate cut odds", "semiconductor tariffs").',
    ),
  hours: z.number().min(1).max(168).optional().describe('Look-back window in hours (default 24).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max stories (default 15).'),
  read: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe('Also fetch and include the body of the top N stories (robots-respecting; slower).'),
  include_market: z
    .boolean()
    .optional()
    .describe('Include market-wide feeds filtered to the symbols (default true).'),
});
export type WebvectorNewsInput = z.infer<typeof webvectorNewsInputSchema>;

export const WEBVECTOR_FILINGS_TOOL_NAME = 'webvector_filings';
export const WEBVECTOR_FILINGS_DESCRIPTION = [
  'SEC EDGAR filings: recent filings for a ticker (8-K with decoded item codes, 10-Q/10-K, Form 4 insider, S-3/424B offerings, 13D/G…) or a full-text search across all filings (phrases like "going concern", "material weakness", "reverse split").',
  'Best for: did the company file something today, what were the 8-K items, insider buying/selling, dilution risk, exhibit 99.1 earnings releases, checking a rumor against the filing.',
  'Not for: the content of a filing (take the URL and call webvector_fetch — sec.gov documents are fetchable); news (webvector_news).',
  'Returns: company header (name, tickers, CIK, SIC) then one line per filing "date FORM [event] — items — <url>", or search hits with company and exhibit; every URL is the primary document on www.sec.gov/Archives.',
  'Common mistakes: forgetting that forms filter is exact ("8-K" matches 8-K and 8-K/A; use "4" for insider forms); searching without quotes for multi-word phrases (wrap exact phrases in \\"…\\"); non-US issuers without a ticker (pass cik).',
  'Example: {"symbol": "TSLA", "forms": ["8-K","4"], "days": 30} or {"query": "\\"going concern\\"", "forms": ["10-Q"], "days": 7}.',
].join(' ');

export const webvectorFilingsInputSchema = z.object({
  symbol: symbolSchema.optional().describe('Ticker (US-listed).'),
  cik: z
    .union([z.string().regex(/^\d{1,10}$/), z.number().int().min(1)])
    .optional()
    .describe('SEC CIK instead of a ticker.'),
  query: z
    .string()
    .min(2)
    .max(200)
    .optional()
    .describe(
      'Full-text search across filings (EDGAR FTS syntax: "quoted phrase", AND/OR, wildcards).',
    ),
  forms: z
    .array(z.string().regex(/^[A-Za-z0-9 /.-]{1,12}$/, 'SEC form type, e.g. 8-K, 10-Q, SC 13D'))
    .max(10)
    .optional()
    .describe('Form types to keep, e.g. ["8-K","10-Q","4","S-3"].'),
  days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe('Look-back in days (default 90; 30 for query).'),
  limit: z.number().int().min(1).max(50).optional().describe('Max filings (default 10).'),
});
export type WebvectorFilingsInput = z.infer<typeof webvectorFilingsInputSchema>;

export const WEBVECTOR_CALENDAR_TOOL_NAME = 'webvector_calendar';
export const WEBVECTOR_CALENDAR_DESCRIPTION = [
  'Scheduled market events ahead: macro prints (CPI, NFP, FOMC, GDP, PMI…) with time (ET), impact, forecast/previous/actual; recent Federal Reserve press releases; and — when the operator enabled the gray Nasdaq source — the earnings calendar for the next sessions.',
  'Best for: "is there a high-impact print before my exit", sizing around FOMC/CPI, knowing what already printed today and how it came in, earnings dates of watchlist names.',
  'Not for: news (webvector_news), company-specific dates other than earnings (webvector_filings for filing deadlines).',
  'Returns: "## Calendar from → to" then one line per event "Tue 08-26 08:30 ET [HIGH] USD CPI m/m — actual/fcst/prev", optional Earnings and Fed sections, and a source report.',
  'Common mistakes: asking for many days with impact "low" (very long); expecting non-US events without countries (pass ["USD","EUR"] or ["ALL"]).',
  'Example: {"days": 2, "impact": "high"} or {"days": 5, "symbols": ["AAPL","AMD"]} for earnings dates.',
].join(' ');

export const webvectorCalendarInputSchema = z.object({
  days: z.number().int().min(1).max(14).optional().describe('Days ahead (default 3).'),
  impact: z.enum(['high', 'medium', 'low']).optional().describe('Minimum impact (default medium).'),
  countries: z
    .array(z.string().min(2).max(4))
    .max(10)
    .optional()
    .describe('Currency codes (default ["USD"]; ["ALL"] for every region).'),
  symbols: z
    .array(symbolSchema)
    .max(20)
    .optional()
    .describe('Filter earnings rows to these tickers (gray Nasdaq source).'),
  include_fed: z.boolean().optional().describe('Include recent Fed press releases (default true).'),
});
export type WebvectorCalendarInput = z.infer<typeof webvectorCalendarInputSchema>;

export const WEBVECTOR_SENTIMENT_TOOL_NAME = 'webvector_sentiment';
export const WEBVECTOR_SENTIMENT_DESCRIPTION = [
  'Crowd and positioning signals for one ticker: StockTwits stream (share of bullish vs bearish tagged posts, posting velocity, watchers, most-liked posts) and FINRA daily short-sale volume share for the latest session.',
  'Best for: gauging retail attention/skew on a mover, spotting a crowded narrative, a quick read before fading or joining a spike.',
  'Not for: fundamentals or news (use webvector_news/webvector_filings); short interest (FINRA short *volume* is a daily flow share, not short interest).',
  'Returns: one summary line per source plus up to 5 top posts, the short-volume ratio, and a source report; reminds you that crowd sentiment is noisy.',
  'Common mistakes: treating a 70% bullish ratio as a signal on 8 posts (check the message count); calling it every tick (cached 2 minutes).',
  'Example: {"symbol": "GME"}.',
].join(' ');

export const webvectorSentimentInputSchema = z.object({
  symbol: symbolSchema.describe('Ticker.'),
  top: z.number().int().min(0).max(10).optional().describe('Top posts to include (default 5).'),
  short_volume: z.boolean().optional().describe('Include FINRA short-sale volume (default true).'),
});
export type WebvectorSentimentInput = z.infer<typeof webvectorSentimentInputSchema>;

export const WEBVECTOR_PULSE_TOOL_NAME = 'webvector_pulse';
export const WEBVECTOR_PULSE_DESCRIPTION = [
  'Market pulse from open sources: Cboe VIX close, FRED Treasury yields (10Y, 2Y) and fed funds; with the gray Yahoo chart source enabled also SPY/QQQ/IWM/DIA, ^VIX, ^TNX, oil, gold, dollar, BTC and any symbols you pass.',
  'Best for: regime check before sizing (vol level, rates trend), index context for a single-name move, a quote for a symbol your broker tool does not cover.',
  'Not for: your positions or executable quotes (use the broker tools); historical series (ask webvector_research for analysis).',
  'Returns: one line per series/quote with last value, change and as-of date/time, a source report, and a note when index quotes were skipped because the gray source is off.',
  'Common mistakes: expecting intraday VIX from the Cboe CSV (daily closes); passing dozens of symbols (each is one request).',
  'Example: {} or {"symbols": ["SMH","XLE"]}.',
].join(' ');

export const webvectorPulseInputSchema = z.object({
  symbols: z.array(symbolSchema).max(10).optional().describe('Extra symbols (gray Yahoo source).'),
  fred_series: z
    .array(z.string().min(2).max(24))
    .max(6)
    .optional()
    .describe('FRED series ids (default DGS10, DGS2, DFF).'),
  basket: z
    .boolean()
    .optional()
    .describe('Include the default index/futures basket (default true).'),
});
export type WebvectorPulseInput = z.infer<typeof webvectorPulseInputSchema>;

export const MARKETS_TOOL_NAMES = [
  WEBVECTOR_NEWS_TOOL_NAME,
  WEBVECTOR_FILINGS_TOOL_NAME,
  WEBVECTOR_CALENDAR_TOOL_NAME,
  WEBVECTOR_SENTIMENT_TOOL_NAME,
  WEBVECTOR_PULSE_TOOL_NAME,
] as const;
export type MarketsToolName = (typeof MARKETS_TOOL_NAMES)[number];
