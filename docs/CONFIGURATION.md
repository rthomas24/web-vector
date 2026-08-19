# Configuration reference

Every option, with its default. Precedence: **code** (`new WebVector({...})`) → **config file** → **environment** → **defaults**.

Config files are searched from the working directory: `webvector.config.{ts,js,mjs,cjs,json,yaml,yml}`, `.webvectorrc`, `.webvectorrc.{json,yaml,yml}`, or a `"webvector"` key in `package.json`. JSON/YAML files are also discovered in parent directories; JS/TS files (which are executed) only in the current directory or via an explicit path. `${VAR}` and `${VAR:-default}` inside string values are filled from the environment.

`webvector init` writes a commented starter file; `webvector config` prints the resolved result (secrets redacted); `webvector doctor` validates it.

## search

| key | default | env | notes |
|---|---|---|---|
| `provider` | `duckduckgo` | `WEBVECTOR_SEARCH_PROVIDER` | `duckduckgo` `brave` `serper` `serpapi` `google-cse` `searxng` `tavily` `tavily-keyless` `exa` `perplexity` `wikipedia`, or a registered custom name |
| `apiKey` | — | provider's own var (`BRAVE_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `PERPLEXITY_API_KEY`, `SERPAPI_API_KEY`, `GOOGLE_CSE_KEY`) or `WEBVECTOR_SEARCH_API_KEY` | |
| `cx` | — | `GOOGLE_CSE_CX` | Google CSE engine id |
| `baseUrl` | — | `SEARXNG_URL` / `WEBVECTOR_SEARCH_BASE_URL` | SearXNG or custom endpoint |
| `resultsPerQuery` | `10` | `WEBVECTOR_RESULTS_PER_QUERY` | 1–100 |
| `safeSearch` | `moderate` | `WEBVECTOR_SAFE_SEARCH` | `off` `moderate` `strict` |
| `country` / `language` | — | `WEBVECTOR_SEARCH_COUNTRY` / `WEBVECTOR_SEARCH_LANGUAGE` | e.g. `US`, `en` |
| `freshness` | — | — | `day` `week` `month` `year` or `{ after, before }` (ISO dates) |
| `fallbackProviders` | `[tavily-keyless, wikipedia]` | `WEBVECTOR_SEARCH_FALLBACKS` (comma-separated) | tried in order when the primary fails or returns nothing |
| `timeoutMs` | `20000` | — | |
| `options` | `{}` | — | passed through to the provider (e.g. DuckDuckGo `region`, Tavily `searchDepth`, Exa `type`) |

Code-only: `search.instance` (a `SearchProvider`), `search.fallbackInstances`.

## embeddings

| key | default | env | notes |
|---|---|---|---|
| `provider` | `auto` | `WEBVECTOR_EMBEDDINGS_PROVIDER` | `auto` (local runtime → hosted key → none) · `none`/`lexical` (BM25 only) · `local` · `openai` · `openai-compatible` (`lmstudio`) · `gemini` · `voyage` · `cohere` · `mistral` · `jina` · `ollama` |
| `model` | provider default (`Xenova/all-MiniLM-L6-v2`, `text-embedding-3-small`, `gemini-embedding-2`, `voyage-4-lite`, `embed-v4.0`, `mistral-embed`, `jina-embeddings-v3`, `nomic-embed-text`) | `WEBVECTOR_EMBEDDINGS_MODEL` | local aliases: `minilm` `fast` `granite` `quality` `embeddinggemma` `best` `bge-small` `bge-base` `bge-m3` `arctic-s` `nomic` `mxbai` `e5-small` `multilingual-e5-small` |
| `apiKey` | — | `OPENAI_API_KEY` `GEMINI_API_KEY` `VOYAGE_API_KEY` `COHERE_API_KEY` `MISTRAL_API_KEY` `JINA_API_KEY` or `WEBVECTOR_EMBEDDINGS_API_KEY` | |
| `baseUrl` | — | `OPENAI_COMPATIBLE_BASE_URL` / `OLLAMA_HOST` / `WEBVECTOR_EMBEDDINGS_BASE_URL` | |
| `dimensions` | model default | `WEBVECTOR_EMBEDDINGS_DIMENSIONS` | Matryoshka truncation where the model supports it |
| `batchSize` | provider limit | `WEBVECTOR_EMBEDDINGS_BATCH_SIZE` | |
| `cacheDir` | `~/.cache/webvector/models` | `WEBVECTOR_MODEL_CACHE` | local model files |
| `dtype` / `device` | `q8` / `cpu` | `WEBVECTOR_EMBEDDINGS_DTYPE` / `WEBVECTOR_EMBEDDINGS_DEVICE` | local only (`fp32`, `coreml`, `cuda`…) |
| `allowRemoteModels` | `true` | `WEBVECTOR_ALLOW_REMOTE_MODELS` | `false` = fully offline (model must be in `cacheDir`) |
| `timeoutMs` | `60000` | — | |
| `options` | `{}` | — | extra request fields for hosted providers |

Code-only: `embeddings.instance` (an `EmbeddingProvider`, e.g. from `webvector/ai-sdk`).

## store

| key | default | env | notes |
|---|---|---|---|
| `provider` | `memory` | `WEBVECTOR_STORE_PROVIDER` | `memory` `chroma` `qdrant` `pgvector`; ignored in lexical mode |
| `mode` | `ephemeral` | `WEBVECTOR_STORE_MODE` | `ephemeral` (per call) · `session` (reuse by `sessionId`, TTL) · `persistent` (external store) |
| `collection` | `webvector` | `WEBVECTOR_STORE_COLLECTION` | table / collection name |
| `url` / `apiKey` | — | `CHROMA_URL` `QDRANT_URL` `QDRANT_API_KEY` `DATABASE_URL` / `WEBVECTOR_STORE_URL` `WEBVECTOR_STORE_API_KEY` | |
| `sessionTtlMs` | `1800000` (30 min) | `WEBVECTOR_SESSION_TTL_MS` | |
| `maxSessions` | `100` | — | LRU |

Code-only: `store.instance` (a `VectorStore`).

## retrieval

| key | default | env | notes |
|---|---|---|---|
| `topK` | `12` | `WEBVECTOR_TOP_K` | passages returned; tool calls may request fewer, never more |
| `candidateMultiplier` | `4` | — | candidates fetched per list before fusion |
| `queryExpansion` / `maxExpandedQueries` | `true` / `4` | `WEBVECTOR_QUERY_EXPANSION` / `WEBVECTOR_MAX_EXPANDED_QUERIES` | heuristic (no LLM); provide `retrieval.llm` for LLM multi-query |
| `hybrid` | `true` | `WEBVECTOR_HYBRID` | BM25 + vectors fused with weighted RRF |
| `rrfK` / `lexicalWeight` / `expansionWeight` | `60` / `0.5` / `0.7` | — | fusion weights |
| `maxPerSource` | `3` | `WEBVECTOR_MAX_PER_SOURCE` | passages per page |
| `mmr` / `mmrLambda` | `true` / `0.7` | `WEBVECTOR_MMR` | diversity re-ranking |
| `recency.weight` / `recency.halfLifeDays` | `0.3` / `180` | — | only when the caller sets `freshness`: score × (1 + w·0.5^(age/halfLife)), capped +30 %, undated pages never penalised; half-life follows the request (day 2 · week 7 · month 30 · year 180), `halfLifeDays` for `{after, before}` |
| `corroborationBoost` / `corroborationJaccard` | `false` / `0.25` | — | `Passage.corroboration` (distinct domains whose chunks say the same thing: word-3-gram Jaccard ≥ threshold or cosine ≥ 0.85) is always reported; the boost × (1 + 0.1·min(n−1, 3)) is opt-in |
| `sourcePriors` / `builtinSourcePriors` | `{}` / `true` | — | glob → score multiplier (hostname globs like `*.gov`, or host/path globs like `github.com/*/*/blob/*/readme*`), merged over tiny built-ins (`*.gov` `*.edu` `*.arxiv.org` `*.wikipedia.org` GitHub READMEs ×1.1; a short aggregator list ×0.85 — set a pattern to `1` to neutralise); combined multiplier clamped to [0.7, 1.3]; shown in `explain.multipliers.sourcePrior` |
| `preferPrimary` / `preferPrimaryBoost` | `true` / `1.15` | — | boost passages whose registrable domain names something in the query (`nodejs.org` ↔ "node", `docs.python.org` ↔ "python"); shown in `explain.multipliers.preferPrimary` |
| `autoRetry` | `0` | — | when `result.evidence.level` is `weak`/`none`, run one more search round with the top suggested queries inside the same call (same run deadline); max `1`; per-call `autoRetry` overrides |
| `aspectCoverage` / `aspectLambda` | `auto` / `0.5` | — | xQuAD-lite: caller-supplied `relatedQueries` are aspects; the top-k is re-selected so every aspect is covered before any gets a third passage; `result.coverage` reports passages per aspect. `off` disables |
| `minScore` | `null` | — | absolute cosine floor |
| `relativeCutoff` | `0.6` | — | drop candidates below 0.6 × the best cosine (0 disables) |
| `nearDuplicateThreshold` | `0.9` | — | shingle-Jaccard dedupe |
| `mergeAdjacent` | `true` | — | neighbouring chunks of one page that both make the cut are returned as one passage (`chunkCount` ≥ 2); counts once toward `maxPerSource`, freed slots are backfilled |
| `rerank` | `false` | `WEBVECTOR_RERANK` | `local` `cohere` `voyage` `jina` `llm` (or `true` = local) |
| `rerankModel` / `rerankApiKey` / `rerankTopN` | provider default / — / `50` | `WEBVECTOR_RERANK_MODEL` / `WEBVECTOR_RERANK_API_KEY` | |
| `fallbackToLexical` | `true` | — | if embedding fails mid-run, return BM25 results (`degraded: 'partial'`) instead of throwing |

Code-only: `retrieval.reranker`, `retrieval.expander`, `retrieval.llm` (`(prompt) => Promise<string>`).

## ingestion

| key | default | env | notes |
|---|---|---|---|
| `maxPages` | `10` | `WEBVECTOR_MAX_PAGES` | pages fetched per call (1–100); tool calls may request fewer, never more |
| `maxConcurrentFetches` / `perHostConcurrency` / `perHostMinIntervalMs` | `8` / `2` / `500` | `WEBVECTOR_MAX_CONCURRENT_FETCHES` | politeness |
| `timeoutMs` / `totalDeadlineMs` | `15000` / `45000` | `WEBVECTOR_FETCH_TIMEOUT_MS` / `WEBVECTOR_TOTAL_DEADLINE_MS` | per request / per run (aborts stragglers) |
| `maxRedirects` / `maxBytes` | `5` / `5242880` | — | |
| `respectRobotsTxt` | `true` | `WEBVECTOR_RESPECT_ROBOTS` | |
| `userAgent` | `Mozilla/5.0 (compatible; WebVector/0.1; +https://github.com/rthomas24/web-vector)` | `WEBVECTOR_USER_AGENT` | |
| `retries` | `2` | — | on network errors / 408 / 429 / 5xx |
| `allowPrivateNetworks` | `false` | `WEBVECTOR_ALLOW_PRIVATE_NETWORKS` | disables the SSRF guard — only for trusted local setups |
| `parsers` | `[html, pdf, text]` | — | |
| `chunkSize` / `chunkOverlap` | `480` / `60` | `WEBVECTOR_CHUNK_SIZE` / `WEBVECTOR_CHUNK_OVERLAP` | tokens |
| `maxChunksPerPage` / `minChunkChars` | `200` / `100` | — | |
| `useProviderContent` | `true` | — | use page text returned by Tavily/Exa instead of fetching |
| `cache.enabled` / `cache.ttlMs` / `cache.maxPages` / `cache.dir` | `true` / `900000` / `500` / — | `WEBVECTOR_CACHE_DIR` (sets `dir`) | in-memory page cache; `dir` adds an on-disk cache |

## output / logging

| key | default | env | notes |
|---|---|---|---|
| `output.markdown` | `true` | `WEBVECTOR_OUTPUT_MARKDOWN` | include `result.markdown` |
| `output.maxPassageChars` | `1500` | — | per passage in the markdown (merged passages may use 2×) |
| `output.maxTokens` | `0` (off) | — | token budget for the rendered markdown; passages are packed by score per token (top passage and one per source first), omitted indices are listed in a footer; `maxOutputTokens` per call can only tighten it |
| `output.highlights` | `true` | — | compute `Passage.highlight` — the best 1–3 sentence window for the query (idf-weighted term coverage, + cosine when an embedder exists); code fences/tables are never cut |
| `output.order` | `score` | — | `date-asc` orders passages oldest → newest (undated first; indices renumbered) so the freshest evidence sits closest to the answer |
| `output.passageMode` | `full` | — | `full` renders whole passages in the markdown; `highlight` renders only each passage's highlight window (~65 % fewer tokens on the eval) |
| `output.includeSnippetsOnFailure` | `true` | — | return search snippets when no page could be fetched (`degraded: 'search_only'`) |
| `logging.level` | `warn` | `WEBVECTOR_LOG_LEVEL` | `silent` `error` `warn` `info` `debug` (stderr) |

Code-only: `logger` (`{ debug, info, warn, error }`), `fetch` (custom fetch implementation).

## Per-call options (`research(query, opts)` / tool arguments)

`relatedQueries` (`related_queries`), `topK` (`top_k`), `maxPages` (`max_pages`), `freshness`, `domainsAllow` (`domains_allow`), `domainsBlock` (`domains_block`), `sessionId` (`session_id`), `signal`, `onProgress`, `rerank`, `markdown`, `autoRetry` (0/1), `maxOutputTokens` (packs passages into the budget and appends an "N more passages omitted" footer; `stats.retrieve.tokensReturned` reports the approximate size). Numeric limits are capped by the configured values above.
