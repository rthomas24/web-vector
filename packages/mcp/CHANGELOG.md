# webvector-mcp

## 0.2.0

### Minor Changes

- Research-driven 0.2: retrieval, extraction, fetch robustness, agent-facing MCP surface, persistence.
  
  **Retrieval** — BM25F fields (title/heading/body) with proximity, quoted phrases and identifier-aware tokens; BM25+ δ; relative-score fusion (`retrieval.fusion: rsf`, default) with `lexicalWeight 1.5`; per-source candidate cap (fixes long pages starving primary sources); lexical relative cutoff, lexical MMR, autocut; per-domain preference; adjacent-chunk merge; query-focused highlights; token-budget packing with an explicit omission footer; xQuAD aspect coverage for `relatedQueries` (`result.coverage`); recency boost tied to `freshness`; corroboration count; LLM-free evidence gate (`result.evidence`) with suggested queries and optional `autoRetry`; source-authority priors; `verifyCitations()` quote-grounding check; `explain` option.
  
  **Extraction / fetch** — markdown-first content negotiation (`ingestion.acceptMarkdown`) with a served-markdown cleaner; bot-wall classifier (`FETCH_BLOCKED_BOT`, `FETCH_PAYMENT_REQUIRED`, never retried); Content-Signal etiquette; early abort on non-content types + `maxHtmlBytes`; URL hygiene (redirect unwrap, AMP/mobile folding, `#:~:text=` hint); fast paths (arXiv HTML, GitHub README/blob/issues, Google Docs, npm/PyPI, Hacker News and Stack Exchange APIs); provider-content quality gate; opt-in Wayback fallback; extractor ensemble with page-type routing and a recall guard (`ingestion.html.strategy`); code/table fidelity pre-pass; JS-shell detection (`PARSE_NEEDS_JS`) + pluggable render hook (`ingestion.render`); `__NEXT_DATA__`/RSC recovery; paywall-guarded JSON-LD `articleBody`; ranking-grade metadata (dates, canonical URL, kind, language, word count); same-host boilerplate suppression; PDF page citations (`#page=N`); a 40-fixture extraction regression corpus.
  
  **MCP / agent surface** — tools renamed `webvector_research`, `webvector_fetch`, `webvector_search` (+ `webvector_verify`, `webvector_status`); `--legacy-tool-names` keeps the old names as aliases for one release; server instructions (≤ 2 KB); rewritten descriptions; `response_format: concise|detailed`, slim `structuredContent`, `max_tokens` with omission footer, `depth` presets, `objective`, `category`, `deadline_ms`, `auto_retry`, `max_age_ms`/`cache_mode`; fetch pagination (`start_index`), `include_links`, `selector`; errors that teach; server-minted sessions; `--max-uses` / `--allowed-domains` / `--blocked-domains` / `--user-location` guardrails; `research` and `verify_claim` prompts; MCP registry files; Anthropic `search_result` blocks; link stripping and text-fragment deep links.
  
  **Persistence / DX** — SQLite page cache on by default (`~/.cache/webvector/pages.sqlite`, ETag/Last-Modified revalidation, per-call `maxAgeMs`/`cacheMode`), persistent embedding cache, `store.provider: sqlite`, single-flight + negative cache, `stats.usage` (+ opt-in cost estimate), `webvector cache stats|ls|clear|prune`, `doctor --fix/--json`, config JSON Schema + `webvector init`, opt-in OpenTelemetry spans, `ingestion.maxCrawlDelayMs`, self-describing User-Agent.
  
  **Testing** — `recordingFetch()` in `webvector/testing`; offline retrieval eval (`npm run eval`, 32 recorded cases, both tiers, baseline gate in CI).

### Patch Changes

- Updated dependencies
  - webvector@0.2.0
