# Research notes: free, keyless, at-scale web sources for trading agents (Aug 2026)

Background for the `markets` module (`docs/MARKETS.md`). Everything below was probed live on 2026-08-22/23 from a US residential IP with the honest `WebVector/<ver>` User-Agent unless noted; robots.txt lines were read from the live files. "Gray" = works keyless but robots/terms/UA requirements argue against automation. This is engineering research, not legal advice.

## 1. What a trading agent actually lacks

A broker integration gives prices, positions and order entry. The deterministic context a trading loop can compute (technicals, earnings *date*, tradability) leaves these questions unanswered every run:

1. **Why is this moving right now?** (catalyst attribution)
2. **What happened since my last run?** (timestamped, deduped headlines)
3. **What did the company file?** (8-K items, Form 4, S-3/424B dilution, 13D/G)
4. **Analyst actions / guidance / earnings content**, not just the date
5. **What is scheduled?** (CPI/NFP/FOMC with times; earnings dates)
6. **Is the crowd crowded?** (sentiment skew, attention)
7. **Regime**: VIX, yields, index context — is the move idiosyncratic or market-wide?

Design consequences: results must be **compact** (no truncation between tool and model), **fast** (< 15 s, cached on repeat), **deduped** (the same wire story is on 20 sites), **timestamped** and **event-tagged** so the agent can decide whether to read further.

## 2. Source verdicts

### Regulatory (open — the backbone)

| Source | Endpoint | Verdict |
|---|---|---|
| SEC submissions | `data.sec.gov/submissions/CIK##########.json` | 200 with a declared UA of the form `Name (contact)`; **403 "Undeclared Automated Tool" without it or with a URL in the UA**. `filings.recent` arrays (form, filingDate, items, primaryDocument…). Cache ≈5 min. |
| SEC full-text search | `efts.sec.gov/LATEST/search-index?q=…&forms=…&dateRange=custom&startdt=&enddt=[&ciks=]` | 200; Elasticsearch hits with `adsh`, `items`, `file_type`, `display_names`. |
| Ticker map | `sec.gov/files/company_tickers_exchange.json` | 200, `Last-Modified`; daily refresh. |
| Archives | `sec.gov/Archives/edgar/data/<cik>/<acc>/<doc>` | robots `Allow: /Archives/edgar/data` → filings are fetchable with the normal pipeline. |
| EDGAR Atom feeds | `cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom` | 200 but robots `Disallow: /cgi-bin` — not used; submissions + FTS cover it. |

Fair-access policy: ≤10 req/s across SEC hosts; the client declares `WebVector/<ver> (<contact>)` and the fetcher paces per host.

### Per-ticker news feeds

| Source | Verdict |
|---|---|
| Yahoo Finance RSS `feeds.finance.yahoo.com/rss/2.0/headline?s=SYM` | alive, 200, `max-age=300`; robots on the feeds host is `Disallow: /` (crawler-oriented) → **feed** policy. Pads with loosely related pieces → results filtered to stories that mention the company. |
| Seeking Alpha `seekingalpha.com/api/sa/combined/SYM.xml` | 200, ETag, `max-age=180`; path allowed for `*`; headlines only (articles paywalled) → **feed**. |
| Bing News RSS `bing.com/news/search?q=…&format=rss` | 200; robots disallows `/search` not `/news/search`; Microsoft's notice says personal use; links are `apiclick` redirectors (unwrapped) → **open**, ≤1 req/s. |
| Google News RSS `news.google.com/rss/search?q=…` | 200, but `/rss` is not in the robots allowlist and the licence is personal/non-commercial; links are opaque `rss/articles/…` ids (new `AU_yqL` ids need the batchexecute dance; brittle) → **gray**. |
| Nasdaq `nasdaq.com/feed/rssoutbound?symbol=SYM` | 200 only with a browser UA (Akamai hangs otherwise); robots `Crawl-delay: 30` → **gray**. |
| DuckDuckGo news | 403 / robots `Disallow: /*?` → skip. |

### Market-wide feeds (filtered to the agent's symbols)

CNBC `cnbc.com/id/100003114/device/rss/rss.html` (200, ttl 60; AI UAs blocked by name for *pages*), MarketWatch `feeds.content.dowjones.io/public/rss/mw_realtimeheadlines|mw_bulletins` (200, ETag; **never fetch marketwatch.com pages**), Benzinga `benzinga.com/feed` (200, 300 KB, ETag), GlobeNewswire `RssFeed/orgclass/1/…` (200, `max-age≈22`, `/RssFeed/` allowed; best free press-release source), PR Newswire `prnewswire.com/rss/financial-services-latest-news/…` (200, ETag, `max-age=60`), Fed `federalreserve.gov/feeds/press_all.xml` (200, no robots.txt). Business Wire: `feed.businesswire.com` robots disallows `/rss/`, www is Akamai 403 → absent. Accesswire: `/rss` disallowed → absent. Reuters: no RSS, `Disallow: /` → absent.

### Calendar / macro

| Source | Verdict |
|---|---|
| Forex Factory JSON mirror `nfs.faireconomy.media/ff_calendar_thisweek.json` (+`nextweek`, 404 until published late in the week) | 200, ETag, `max-age=60`; title, country (currency), ISO time with offset, impact, forecast/previous/actual → **open**. |
| Fed press RSS | see above. |
| Nasdaq earnings `api.nasdaq.com/api/calendar/earnings?date=` | 200 only with browser UA → **gray**. |
| FRED CSV `fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES` | 200; robots `Crawl-delay: 1` (honoured); **multi-id requests return a zip** → one series per request. |
| Cboe VIX `cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv` | 200, ETag, `max-age=900`. |
| Treasury yield XML/CSV | 200 but robots.txt says `Disallow: /` (stale staging copy) → not used; FRED covers yields. |
| CME FedWatch, Investing.com calendar, TradingEconomics | 403 / Cloudflare / heavy → absent. |
| BLS v1 API | 200 keyless but robots `Disallow: /`, 25 queries/day → not used. |

### Sentiment

| Source | Verdict |
|---|---|
| StockTwits `api.stocktwits.com/api/2/streams/symbol/SYM.json` | 200 keyless, ETag, ~200 req/h/IP; robots disallows query strings only; `entities.sentiment.basic` Bullish/Bearish, likes, watchlist_count → **open**. |
| FINRA daily short volume `cdn.finra.org/equity/regsho/daily/CNMSshvolYYYYMMDD.txt` | 200, pipe-delimited, ~540 KB, published after close → **open**; short volume / total volume per symbol (a flow share, not short interest). |
| Reddit | `.json` → 403 (unauthenticated JSON cut off May 2026); RSS works but ~1 req/min → not used. |
| Google Trends | 429 → absent. |

### Quotes (secondary — the broker should supply these)

Yahoo chart `query2.finance.yahoo.com/v8/finance/chart/SYM` → 200 keyless, no crumb, `max-age=10`, but robots `Disallow: /` + terms → **gray**. Stooq → JS challenge + `Disallow: /` → absent. Nasdaq quote API → browser UA → gray. TradingView scanner → terms → absent.

## 3. Politeness rules baked into the module

- Honest UA (`WebVector/<ver> (+repo; user-directed research agent)`), `From:` contact header; SEC-specific `WebVector/<ver> (<contact>)`; browser UA only for gray hosts that hang otherwise (and only when gray is on).
- Per-host concurrency/min-gap from the Fetcher (default 2 / 500 ms) raised per source (FRED 1 s, Bing 1 s, StockTwits 1 s, Google 2 s, Nasdaq 30 s) through the same queue robots `Crawl-delay` uses.
- robots.txt honoured for everything except (a) syndication feeds on crawler-blocking hosts when `feedRobots: 'exempt'` and (b) gray sources the operator explicitly enabled. Content-Signal `ai-input=no` response headers are still enforced by the Fetcher.
- Conditional GETs (ETag / If-Modified-Since) wherever the origin sends validators; TTLs match origin `max-age`; stale copy served on error for up to 24 h; 404s of date-probed files remembered briefly; single-flight for concurrent identical calls.
- Bot-walls (Cloudflare/Akamai/DataDome… markers) are classified by the Fetcher and never retried; a failed source becomes a `SourceRun` line, never an exception for the whole call; one deadline per call.
- Article bodies only via `WebVector.fetch` (robots-respecting, domain allow/block lists). Headlines from Dow Jones/Reuters/etc. feeds may be shown; their pages are not read.

## 4. Techniques that informed the design

- **Discovery without search APIs**: per-ticker RSS + wire feeds + EDGAR beat SERP scraping for freshness and legality; Google News sitemaps still emit `<news:stock_tickers>` on wire sites (opportunistic, not relied on).
- **Dedupe**: story key (redirectors unwrapped, tracking params stripped) + banded 64-bit SimHash over title unigrams/bigrams (Hamming ≤ 3) collapses syndicated copies; the number of distinct sources (`spread`) is a cheap "how widely carried" signal; earliest timestamp kept as first-seen.
- **Event classification**: keyword rules ordered earnings → guidance → analyst → M&A → FDA → insider → offering → buyback → dividend → legal → exec → contract → product → macro; 8-K item numbers (2.02 results, 1.01 agreements, 5.02 officers, 3.02 unregistered sales, 4.02 restatement) map directly to events.
- **Ticker recognition**: cashtags, `(NASDAQ: X)` / `NYSE:X` patterns (symbol upper-case), bare upper-case tickers as whole words (case-sensitive, so NOW/ALL/CAT don't match prose), and company-name aliases from the SEC map ("Apple Inc." → "apple").
- **Budgeting**: one deadline for the fan-out (default 12 s); sources that miss it are reported as `timeout`; repeat calls inside the TTL make zero requests.

## 5. Not done / future

- Google News redirect resolution (batchexecute) — only worth it if gray sources are on; left as "links resolve via redirect in a browser; bodies are not fetched".
- WebSub push, news sitemaps as a discovery layer, per-company wire feeds (GlobeNewswire organization ids, Business Wire tokens) — useful for an always-on watcher; out of scope for the on-demand tools.
- Form 4 XML parsing into buy/sell summaries; XBRL companyfacts fundamentals (3–4 MB per company; needs disk caching) — natural next adapters on the open SEC surface.
