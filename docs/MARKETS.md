# Markets: news, filings, calendar, sentiment, pulse

`wv.markets` (library), `webvector/markets` (subpath) and the opt-in MCP tools `webvector_news`, `webvector_filings`, `webvector_calendar`, `webvector_sentiment`, `webvector_pulse` give a trading or research agent the things a plain web search does badly: *what just happened to this ticker*, *what did the company file*, *what prints are scheduled*, *how is the crowd positioned*, *what regime are we in* — from **free, keyless sources that were verified to allow it**, in one compact call that fits an agent's turn budget.

Nothing here changes the research pipeline. The module shares the instance's polite `Fetcher` (SSRF guard, per-host pacing, bot-wall detection, size caps) and adds a TTL cache (`markets_cache` table in the page-cache SQLite) with ETag/Last-Modified revalidation and stale-on-error.

```ts
import { WebVector, renderNews } from 'webvector';
const wv = new WebVector({ ingestion: { contactEmail: 'you@example.com' } }); // SEC asks for a contact
const news = await wv.markets.news({ symbols: ['NVDA'], windowMs: 12 * 3_600_000, limit: 10 });
console.log(renderNews(news));                      // one line per story, newest first
const k = await wv.markets.filings({ symbol: 'NVDA', forms: ['8-K', '4'], days: 30 });
const cal = await wv.markets.calendar({ days: 2, impact: 'high' });
const st = await wv.markets.sentiment({ symbol: 'NVDA' });
const pulse = await wv.markets.pulse();
```

MCP:

```bash
npx -y webvector-mcp --tools research,fetch,markets            # core research + the five markets tools
WEBVECTOR_MCP_TOOLS=research,fetch,markets WEBVECTOR_CONTACT_EMAIL=you@example.com npx -y webvector-mcp
```

## What each call returns

| Call | Sources (default on) | Output |
|---|---|---|
| `news({ symbols \| query, windowMs, limit, includeMarket, read })` | per-ticker: Yahoo Finance RSS, Seeking Alpha symbol RSS, Bing News RSS · market-wide (filtered to the symbols, or a briefing when no symbols): CNBC, MarketWatch real-time + bulletins, Benzinga, GlobeNewswire public companies, PR Newswire financial, Fed press | `NewsItem[]` newest first — title, url, publisher, publishedAt, summary, tickers (cashtags / `(NASDAQ: X)` / query symbol), `event` tag, `spread` (distinct sources carrying the story) + `alsoIn`; `sources[]` report; `read: N` attaches the body of the top N via `WebVector.fetch` (robots-respecting — Dow Jones/Reuters pages stay unread) |
| `filings({ symbol \| cik, forms, days, limit })` / `searchFilings({ query, forms, symbol, days, limit })` | SEC EDGAR submissions API / full-text search (`efts`) | `Filing[]` with form, dates, accession, primary-document URL on `www.sec.gov/Archives`, index URL, decoded 8-K items (`2.02 Results of Operations…`), event tag; company header (name, tickers, CIK, SIC) |
| `calendar({ days, impact, countries, fed, earnings, symbols })` | Forex Factory JSON calendar (this + next week), Fed press RSS; earnings only with the gray Nasdaq source | `CalendarEvent[]` (ISO time, impact, forecast/previous/actual), recent Fed releases, optional earnings rows |
| `sentiment({ symbol, top, shortVolume })` | StockTwits symbol stream, FINRA consolidated short-sale volume | bull/bear counts and ratio, msgs/hour, watchers, top posts; short volume / total volume for the latest session |
| `pulse({ symbols, fredSeries, basket })` | Cboe VIX CSV, FRED (DGS10, DGS2, DFF); Yahoo chart API only when gray sources are on | `SeriesSnapshot[]` (last, prev, change) and `QuoteSnapshot[]` (price, % change, range, as-of) |
| `status()` | — | every catalog source with its policy and whether it is enabled under the current config |

Renderers (`renderNews`, `renderFilings`, `renderCalendar`, `renderSentiment`, `renderPulse`) produce the compact Markdown the MCP tools return: one line per item, ET timestamps with age, a `Sources:` line (`ok` / `cached` / `failed [reason]` / `skipped [reason]`), and a short untrusted-content note. Times in rendered output are US/Eastern because that is what trading agents reason in; the structured results carry ISO timestamps.

## Source policy (the honest part)

Every source in [`packages/core/src/markets/sources.ts`](../packages/core/src/markets/sources.ts) was probed live (2026-08-22/23) with the default `WebVector/<ver>` User-Agent and classified:

| Policy | Meaning | Default | Examples |
|---|---|---|---|
| `open` | documented public API or feed; robots.txt allows the path | on | SEC EDGAR (submissions, full-text search, ticker map), Cboe VIX CSV, FRED CSV, Fed press RSS, FINRA short volume, StockTwits symbol stream, Forex Factory JSON, Bing News RSS, CNBC / MarketWatch / Benzinga / GlobeNewswire / PR Newswire feeds |
| `feed` | a syndication endpoint (RSS published for readers) on a host whose robots.txt is a blanket `Disallow: /` aimed at page crawlers | on; the robots check is skipped **for that request only** (`markets.feedRobots: 'exempt'`; set `'respect'` to skip these sources instead) | Yahoo Finance per-ticker RSS, Seeking Alpha symbol RSS |
| `gray` | keyless and widely used, but robots.txt / terms / a browser-UA requirement argue against automated use | **off** (`markets.graySources: true` to enable) | Google News RSS (`/rss` not in the robots allowlist; personal, non-commercial licence), Nasdaq symbol RSS + earnings API (Akamai hangs on non-browser UAs; Crawl-delay 30), Yahoo chart API (`Disallow: /`) |

Deliberately **absent**: Reuters, Bloomberg, WSJ/Barron's/MarketWatch *pages*, FT, Seeking Alpha *articles*, TradingView, Zacks, Morningstar, Stooq, CME, Investing.com HTML, Business Wire (`feed.businesswire.com` disallows `/rss/`), Accesswire, Reddit JSON (403 since 2026). Article bodies are only ever fetched through `WebVector.fetch`, which honours robots.txt — so a MarketWatch headline can appear in `news()` but the page is never scraped.

Politeness is the Fetcher's per-host queue (concurrency 2, 500 ms default, robots `Crawl-delay` honoured) with each source's declared `minIntervalMs` raised on its hosts (FRED 1 s = its Crawl-delay, Bing 1 s, StockTwits 1 s, Google 2 s, Nasdaq 30 s); TTLs match the origins' `max-age` (Yahoo 5 min, GlobeNewswire/PRN 2 min, Cboe 15 min, FRED 1 h, SEC ticker map 24 h), refreshes are conditional where the origin sends validators, a stale copy is served when a refresh fails, and 404s of date-probed files (FINRA, next-week calendar) are remembered so they are not re-probed every call. Every call runs under one deadline (`markets.deadlineMs`, default 12 s): a source that has not answered by then is reported as `timeout` and the rest of the result is returned on time; a source that is asked several times in one call (one per symbol) is reported once, with `n/m failed` when only some requests failed.

Relevance: per-ticker aggregator feeds (Yahoo in particular) pad with loosely related pieces, so stories are kept only when they mention the ticker (cashtag / `(NASDAQ: X)` / bare upper-case ticker of ≥ 3 letters) or the company name; if nothing explicit comes back the feed's items are used as-is. Bare tickers are matched case-sensitively, so word-tickers (NOW, ALL, CAT, LOW…) do not light up on prose. Bing links are `apiclick` redirectors — they are unwrapped for dedupe (and for `webvector_fetch`), Google News ids are not readable without JavaScript and are skipped by `read`.

**SEC User-Agent.** EDGAR requires a declared agent of the form `Name (contact)` and rejects UAs that contain a URL, so SEC requests use `WebVector/<ver> (<contact>)` with `markets.contact` or `ingestion.contactEmail`. Without a contact EDGAR returns 403 (the tool result says so) — set `WEBVECTOR_CONTACT_EMAIL` or `WEBVECTOR_MARKETS_CONTACT`.

## Configuration

```yaml
markets:
  graySources: false          # Google News RSS, Nasdaq, Yahoo chart API
  feedRobots: exempt          # exempt | respect — syndication feeds on crawler-blocking hosts
  disableSources: []          # e.g. [benzinga, stocktwits]
  contact: you@example.com    # SEC EDGAR UA (falls back to ingestion.contactEmail)
  deadlineMs: 12000           # wall-clock budget per call (all sources in parallel)
```

Env: `WEBVECTOR_MARKETS_GRAY_SOURCES`, `WEBVECTOR_MARKETS_FEED_ROBOTS`, `WEBVECTOR_MARKETS_DISABLE_SOURCES` (comma list), `WEBVECTOR_MARKETS_CONTACT`, `WEBVECTOR_MARKETS_DEADLINE_MS`.

## How it works (for contributors)

```
markets/
  sources.ts    the catalog: id, kind, policy, hosts, url (fixed or builder), ttl, min interval, trust, ua, notes;
                sourceEnabled() / robotsModeFor() derive behaviour from the policy
  client.ts     MarketsClient — policy gate → Fetcher (host pacing from the catalog, declared/browser UA) → TTL cache;
                runSources() fans tasks out under one deadline and reports one SourceRun per source
  cache.ts      MarketsCache — LRU + `markets_cache` SQLite table, ETag/Last-Modified, stale-on-error, single-flight, missing-markers
  feed.ts       RSS 2.0 / Atom / RDF parser on linkedom's XML DOM (no new dependency); text via cleanSnippet, dates normalised
  tickers.ts    SEC ticker ↔ CIK ↔ name directory; cashtag / exchange-pattern / alias mention matchers
  dedupe.ts     story key (redirectors unwrapped) + banded 64-bit SimHash(title) dedupe → spread, most-trusted representative
  classify.ts   event tags from headlines; 8-K item labels; filing → event
  news.ts / filings.ts / calendar.ts / sentiment.ts / pulse.ts   the five capabilities
  render.ts     compact Markdown for tool output + capMarkdown (token budget)
  tool.ts       MCP tool names, descriptions (< 2 KB), zod input schemas
  util.ts       isoDay / clampLimit / padCik / escapeRegExp / weekdaysBack
  index.ts      Markets facade (wv.markets)
```

Adding a source: one entry in `sources.ts` (with the policy you verified — quote the robots.txt lines in `notes`) plus a task in the capability that uses it. Tests run fully offline against a fake `fetch` (`packages/core/test/markets.test.ts`, `packages/mcp/test/markets.test.ts`).

## Using it from a trading agent

A typical agent harness registers the MCP server once (stdio: `npx -y webvector-mcp --tools research,fetch,markets`; remote runners use `--http` with a bearer token) and lets the model call the tools as `mcp__<server>__webvector_news` etc. Notes that matter:

- Agent loops usually have a tight per-run budget and no truncation between a tool result and the model — the markets tools are built for that (one compact call, 12 s deadline by default, `--max-tokens` cap, cached on repeat).
- Pass the operator's contact as `WEBVECTOR_CONTACT_EMAIL` (or `WEBVECTOR_MARKETS_CONTACT`) so SEC EDGAR calls work out of the box.
- A sensible routing hint for the system prompt: *"webvector_news for the catalyst behind a gap or an unexplained move, webvector_filings before holding into a filing window, webvector_calendar before sizing around 8:30/14:00 ET prints — one or two calls, then decide."*
