---
'webvector': minor
'webvector-mcp': minor
---

feat(markets): news / SEC filings / calendar / sentiment / pulse for trading and research agents.

- `wv.markets` (and `webvector/markets`): headlines per ticker or market briefing from free, keyless feeds (Yahoo Finance, Seeking Alpha, Bing News, CNBC, MarketWatch, Benzinga, GlobeNewswire, PR Newswire, Fed) deduped across sources with a spread count and event tags; SEC EDGAR filing history + full-text search with decoded 8-K items and archive URLs; macro calendar (Forex Factory JSON) + Fed releases; StockTwits + FINRA short volume; VIX (Cboe) + FRED yields. Every source is classified open / feed / gray in `markets/sources.ts`; gray ones (Google News RSS, Nasdaq, Yahoo chart API) are off unless `markets.graySources` is set.
- All requests go through the existing polite Fetcher (SSRF guard, per-host pacing, bot-wall detection) plus a TTL cache with ETag/Last-Modified revalidation in the page-cache SQLite (`markets_cache`). Fetcher additions: `FetchInit.robots: 'skip'` (default `respect`) for syndication endpoints and `Fetcher.setHostMinInterval(host, ms)` so callers can declare a host's known limits through the same queue robots `Crawl-delay` uses; `cleanUrl` now unwraps Bing News `apiclick` redirectors.
- New `markets` config section (`graySources`, `feedRobots`, `disableSources`, `contact`, `deadlineMs`; `WEBVECTOR_MARKETS_*` env).
- MCP: opt-in tools `webvector_news`, `webvector_filings`, `webvector_calendar`, `webvector_sentiment`, `webvector_pulse` via `--tools markets` (default `tools/list` unchanged); their text output is capped to `--max-tokens` and body reads honour `--allowed-domains` / `--blocked-domains`.
- Security: `ToolGuard` domain policy now also applies to the unwrapped target of redirect-wrapper URLs (google.com/url, bing.com/news/apiclick, …), closing an allow/block bypass for `webvector_fetch`.
