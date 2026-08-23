# webvector

## 0.3.0

### Minor Changes

- 67d99ea: feat(markets): news / SEC filings / calendar / sentiment / pulse for trading and research agents.
  
  - `wv.markets` (and `webvector/markets`): headlines per ticker or market briefing from free, keyless feeds (Yahoo Finance, Seeking Alpha, Bing News, CNBC, MarketWatch, Benzinga, GlobeNewswire, PR Newswire, Fed) deduped across sources with a spread count and event tags; SEC EDGAR filing history + full-text search with decoded 8-K items and archive URLs; macro calendar (Forex Factory JSON) + Fed releases; StockTwits + FINRA short volume; VIX (Cboe) + FRED yields. Every source is classified open / feed / gray in `markets/sources.ts`; gray ones (Google News RSS, Nasdaq, Yahoo chart API) are off unless `markets.graySources` is set.
  - All requests go through the existing polite Fetcher (SSRF guard, per-host pacing, bot-wall detection) plus a TTL cache with ETag/Last-Modified revalidation in the page-cache SQLite (`markets_cache`). Fetcher additions: `FetchInit.robots: 'skip'` (default `respect`) for syndication endpoints and `Fetcher.setHostMinInterval(host, ms)` so callers can declare a host's known limits through the same queue robots `Crawl-delay` uses; `cleanUrl` now unwraps Bing News `apiclick` redirectors.
  - New `markets` config section (`graySources`, `feedRobots`, `disableSources`, `contact`, `deadlineMs`; `WEBVECTOR_MARKETS_*` env).
  - MCP: opt-in tools `webvector_news`, `webvector_filings`, `webvector_calendar`, `webvector_sentiment`, `webvector_pulse` via `--tools markets` (default `tools/list` unchanged); their text output is capped to `--max-tokens` and body reads honour `--allowed-domains` / `--blocked-domains`.
  - Security: `ToolGuard` domain policy now also applies to the unwrapped target of redirect-wrapper URLs (google.com/url, bing.com/news/apiclick, …), closing an allow/block bypass for `webvector_fetch`.

## 0.2.0

### Minor Changes

- Research-driven 0.2: retrieval, extraction, fetch robustness, agent-facing MCP surface, persistence.
  
  **Retrieval** — BM25F fields (title/heading/body) with proximity, quoted phrases and identifier-aware tokens; BM25+ δ; relative-score fusion (`retrieval.fusion: rsf`, default) with `lexicalWeight 1.5`; per-source candidate cap (fixes long pages starving primary sources); lexical relative cutoff, lexical MMR, autocut; per-domain preference; adjacent-chunk merge; query-focused highlights; token-budget packing with an explicit omission footer; xQuAD aspect coverage for `relatedQueries` (`result.coverage`); recency boost tied to `freshness`; corroboration count; LLM-free evidence gate (`result.evidence`) with suggested queries and optional `autoRetry`; source-authority priors; `verifyCitations()` quote-grounding check; `explain` option.
  
  **Extraction / fetch** — markdown-first content negotiation (`ingestion.acceptMarkdown`) with a served-markdown cleaner; bot-wall classifier (`FETCH_BLOCKED_BOT`, `FETCH_PAYMENT_REQUIRED`, never retried); Content-Signal etiquette; early abort on non-content types + `maxHtmlBytes`; URL hygiene (redirect unwrap, AMP/mobile folding, `#:~:text=` hint); fast paths (arXiv HTML, GitHub README/blob/issues, Google Docs, npm/PyPI, Hacker News and Stack Exchange APIs); provider-content quality gate; opt-in Wayback fallback; extractor ensemble with page-type routing and a recall guard (`ingestion.html.strategy`); code/table fidelity pre-pass; JS-shell detection (`PARSE_NEEDS_JS`) + pluggable render hook (`ingestion.render`); `__NEXT_DATA__`/RSC recovery; paywall-guarded JSON-LD `articleBody`; ranking-grade metadata (dates, canonical URL, kind, language, word count); same-host boilerplate suppression; PDF page citations (`#page=N`); a 40-fixture extraction regression corpus.
  
  **MCP / agent surface** — tools renamed `webvector_research`, `webvector_fetch`, `webvector_search` (+ `webvector_verify`, `webvector_status`); `--legacy-tool-names` keeps the old names as aliases for one release; server instructions (≤ 2 KB); rewritten descriptions; `response_format: concise|detailed`, slim `structuredContent`, `max_tokens` with omission footer, `depth` presets, `objective`, `category`, `deadline_ms`, `auto_retry`, `max_age_ms`/`cache_mode`; fetch pagination (`start_index`), `include_links`, `selector`; errors that teach; server-minted sessions; `--max-uses` / `--allowed-domains` / `--blocked-domains` / `--user-location` guardrails; `research` and `verify_claim` prompts; MCP registry files; Anthropic `search_result` blocks; link stripping and text-fragment deep links.
  
  **Persistence / DX** — SQLite page cache on by default (`~/.cache/webvector/pages.sqlite`, ETag/Last-Modified revalidation, per-call `maxAgeMs`/`cacheMode`), persistent embedding cache, `store.provider: sqlite`, single-flight + negative cache, `stats.usage` (+ opt-in cost estimate), `webvector cache stats|ls|clear|prune`, `doctor --fix/--json`, config JSON Schema + `webvector init`, opt-in OpenTelemetry spans, `ingestion.maxCrawlDelayMs`, self-describing User-Agent.
  
  **Testing** — `recordingFetch()` in `webvector/testing`; offline retrieval eval (`npm run eval`, 32 recorded cases, both tiers, baseline gate in CI).
