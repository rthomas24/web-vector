/**
 * Markets tools for the MCP server (opt-in: `--tools markets` or `--tools research,fetch,news,…`):
 *   webvector_news       headlines per ticker / market briefing (feeds, deduped, event-tagged)
 *   webvector_filings    SEC EDGAR filings per ticker or full-text search
 *   webvector_calendar   macro calendar + Fed releases (+ earnings with the gray Nasdaq source)
 *   webvector_sentiment  StockTwits stream + FINRA short volume
 *   webvector_pulse      VIX, yields, (indices with the gray Yahoo source)
 *
 * Kept out of the default tool list so existing `tools/list` order and behaviour are unchanged.
 * Every tool shares one wrapper: guard → WebVector → call → render (capped to the server's token
 * budget) → text + structuredContent; errors are returned in-band like the core tools.
 */
import type {
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import {
  capMarkdown,
  MARKETS_TOOL_NAMES,
  type MarketsToolName,
  renderCalendar,
  renderFilings,
  renderNews,
  renderPulse,
  renderSentiment,
  type ToolGuard,
  WEBVECTOR_CALENDAR_DESCRIPTION,
  WEBVECTOR_CALENDAR_TOOL_NAME,
  WEBVECTOR_FILINGS_DESCRIPTION,
  WEBVECTOR_FILINGS_TOOL_NAME,
  WEBVECTOR_NEWS_DESCRIPTION,
  WEBVECTOR_NEWS_TOOL_NAME,
  WEBVECTOR_PULSE_DESCRIPTION,
  WEBVECTOR_PULSE_TOOL_NAME,
  WEBVECTOR_SENTIMENT_DESCRIPTION,
  WEBVECTOR_SENTIMENT_TOOL_NAME,
  type WebVector,
  type WebvectorCalendarInput,
  type WebvectorFilingsInput,
  type WebvectorNewsInput,
  type WebvectorPulseInput,
  type WebvectorSentimentInput,
  webvectorCalendarInputSchema,
  webvectorFilingsInputSchema,
  webvectorNewsInputSchema,
  webvectorPulseInputSchema,
  webvectorSentimentInputSchema,
} from 'webvector';
import { argumentError, errorResult } from './results.js';

/** `--tools markets` (bin.ts prefixes short names → `webvector_markets`) expands to every markets tool. */
export const MARKETS_GROUP = 'webvector_markets';

export function expandMarketsGroup(tools: string[]): string[] {
  return [...new Set(tools.flatMap((t) => (t === MARKETS_GROUP ? [...MARKETS_TOOL_NAMES] : [t])))];
}

export function hasMarketsTools(tools: Set<string>): boolean {
  return MARKETS_TOOL_NAMES.some((n) => tools.has(n));
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

export interface MarketsToolsContext {
  server: McpServer;
  tools: Set<string>;
  wvp: () => Promise<WebVector>;
  guard: ToolGuard;
  /** Whether to attach `structuredContent` (mirrors the server's `--structured` mode). */
  structured: boolean;
  /** Token budget for the rendered text (the server's `--max-tokens`). */
  maxTokens?: number;
}

type Rendered = { text: string; data: unknown };
type Handler<In> = (
  wv: WebVector,
  args: In,
) => Promise<Rendered | ReturnType<typeof argumentError>>;

/** Register the enabled markets tools. No-op when none is selected. */
export function registerMarketsTools(ctx: MarketsToolsContext): void {
  const { server, tools, wvp, guard, structured, maxTokens } = ctx;
  const allowed = (url: string) => {
    try {
      guard.assertUrlAllowed(url);
      return true;
    } catch {
      return false;
    }
  };
  const register = <In>(
    name: MarketsToolName,
    title: string,
    description: string,
    inputSchema: StandardSchemaWithJSON,
    handler: Handler<In>,
  ) => {
    if (!tools.has(name)) return;
    server.registerTool(
      name,
      { title, description, inputSchema, annotations: READ_ONLY },
      async (args: unknown) => {
        try {
          guard.consume();
          const r = await handler(await wvp(), args as In);
          if ('content' in r) return r; // argument error
          return {
            content: [{ type: 'text' as const, text: capMarkdown(r.text, maxTokens) }],
            ...(structured ? { structuredContent: JSON.parse(JSON.stringify(r.data)) } : {}),
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  };

  register<WebvectorNewsInput>(
    WEBVECTOR_NEWS_TOOL_NAME,
    'Ticker / market news (free feeds, deduped, event-tagged)',
    WEBVECTOR_NEWS_DESCRIPTION,
    webvectorNewsInputSchema,
    async (wv, a) => {
      const res = await wv.markets.news({
        symbols: a.symbols,
        query: a.query,
        windowMs: (a.hours ?? 24) * 3_600_000,
        limit: a.limit,
        includeMarket: a.include_market,
        read: a.read,
        canRead: allowed,
      });
      return { text: renderNews(res), data: res };
    },
  );

  register<WebvectorFilingsInput>(
    WEBVECTOR_FILINGS_TOOL_NAME,
    'SEC EDGAR filings (per ticker or full-text search)',
    WEBVECTOR_FILINGS_DESCRIPTION,
    webvectorFilingsInputSchema,
    async (wv, a) => {
      if (!a.symbol && a.cik === undefined && !a.query)
        return argumentError(
          'MISSING_ARGUMENT',
          'Pass a symbol (or cik) for a filing history, or a query for full-text search.',
          'Example: {"symbol": "AAPL", "forms": ["8-K"]} or {"query": "\\"going concern\\""}.',
        );
      const res = a.query
        ? await wv.markets.searchFilings({
            query: a.query,
            forms: a.forms,
            symbol: a.symbol,
            days: a.days,
            limit: a.limit,
          })
        : await wv.markets.filings({
            symbol: a.symbol,
            cik: a.cik,
            forms: a.forms,
            days: a.days,
            limit: a.limit,
          });
      return { text: renderFilings(res), data: res };
    },
  );

  register<WebvectorCalendarInput>(
    WEBVECTOR_CALENDAR_TOOL_NAME,
    'Macro / Fed / earnings calendar',
    WEBVECTOR_CALENDAR_DESCRIPTION,
    webvectorCalendarInputSchema,
    async (wv, a) => {
      const res = await wv.markets.calendar({
        days: a.days,
        impact: a.impact,
        countries: a.countries,
        symbols: a.symbols,
        fed: a.include_fed,
      });
      return { text: renderCalendar(res), data: res };
    },
  );

  register<WebvectorSentimentInput>(
    WEBVECTOR_SENTIMENT_TOOL_NAME,
    'Crowd sentiment + short volume for one ticker',
    WEBVECTOR_SENTIMENT_DESCRIPTION,
    webvectorSentimentInputSchema,
    async (wv, a) => {
      const res = await wv.markets.sentiment({
        symbol: a.symbol,
        top: a.top,
        shortVolume: a.short_volume,
      });
      return { text: renderSentiment(res), data: res };
    },
  );

  register<WebvectorPulseInput>(
    WEBVECTOR_PULSE_TOOL_NAME,
    'Market pulse (VIX, yields, indices)',
    WEBVECTOR_PULSE_DESCRIPTION,
    webvectorPulseInputSchema,
    async (wv, a) => {
      const res = await wv.markets.pulse({
        symbols: a.symbols,
        fredSeries: a.fred_series,
        basket: a.basket,
      });
      return { text: renderPulse(res), data: res };
    },
  );
}
