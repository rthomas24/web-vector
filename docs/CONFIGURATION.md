# Configuration reference

Every option, with its default. Precedence: **code** (`new WebVector({...})`) → **config file** → **environment** → **defaults**.

Config files are searched from the working directory: `webvector.config.{ts,js,mjs,cjs,json,yaml,yml}`, `.webvectorrc`, `.webvectorrc.{json,yaml,yml}`, or a `"webvector"` key in `package.json`. JSON/YAML files are also discovered in parent directories; JS/TS files (which are executed) only in the current directory or via an explicit path. `${VAR}` and `${VAR:-default}` inside string values are filled from the environment.

`webvector init` writes a commented starter file (interactive on a TTY: search provider ← detected keys, embeddings tier, store, MCP client snippet; `--yes` accepts the detected defaults, `--json` writes JSON); `webvector config` prints the resolved result (secrets redacted); `webvector doctor` validates it.

**Editor support (JSON Schema).** The schema is generated from the zod definitions at build time and shipped in the `webvector` package (`webvector/schema/webvector.config.json`) and at a stable URL: `https://raw.githubusercontent.com/rthomas24/web-vector/main/packages/core/schema/webvector.config.json`. JSON configs may set `"$schema"` to it (ignored at runtime); YAML files get completions with the modeline `# yaml-language-server: $schema=<url>` (both are written by `webvector init`). `webvector config --schema` prints it.

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
| `cache` | `true` | — | persist chunk embeddings in the page cache's `pages.sqlite` (key: model + dimensions + dtype + role + content hash) so re-runs and restarts never re-embed the same text; needs `ingestion.cache.dir` (default `auto`) and `node:sqlite`. The in-process cache is always on. Hits show up in `stats.embed.cached` / `stats.usage.embed.cached` |
| `timeoutMs` | `60000` | — | |
| `options` | `{}` | — | extra request fields for hosted providers |

Code-only: `embeddings.instance` (an `EmbeddingProvider`, e.g. from `webvector/ai-sdk`).

## store

| key | default | env | notes |
|---|---|---|---|
| `provider` | `memory` | `WEBVECTOR_STORE_PROVIDER` | `memory` `sqlite` `chroma` `qdrant` `pgvector`; ignored in lexical mode. `sqlite` is the zero-dependency persistent store (see PROVIDERS.md) |
| `mode` | `ephemeral` | `WEBVECTOR_STORE_MODE` | `ephemeral` (per call) · `session` (reuse by `sessionId`, TTL) · `persistent` (one shared session that survives restarts with `sqlite`/external stores) |
| `collection` | `webvector` | `WEBVECTOR_STORE_COLLECTION` | table / collection name |
| `url` / `apiKey` | — | `WEBVECTOR_SQLITE_STORE` `CHROMA_URL` `QDRANT_URL` `QDRANT_API_KEY` `DATABASE_URL` / `WEBVECTOR_STORE_URL` `WEBVECTOR_STORE_API_KEY` | for `sqlite`, `url` is a file path (default `~/.local/share/webvector/store.sqlite`, `XDG_DATA_HOME` respected) |
| `sessionTtlMs` | `1800000` (30 min) | `WEBVECTOR_SESSION_TTL_MS` | idle sessions are dropped; persistent stores also expire their rows on disk (the `persistent` session is kept) |
| `options.vec` | `false` | — | `sqlite` only: load the optional `sqlite-vec` extension and rank in SQL |
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
| `mmrSimilarity` | `auto` | — | MMR redundancy measure: `auto` = cosine over chunk vectors when available, else word-3-gram Jaccard; `jaccard` forces text similarity; `vector` = cosine when available |
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
| `maxRedirects` / `maxBytes` | `5` / `5242880` | — | `maxBytes` caps every body (PDFs included) |
| `maxHtmlBytes` | `2097152` | — | lower cap for textual bodies (HTML/markdown/plain/XML/JSON); `image/*`, `video/*`, `audio/*`, `font/*`, archives (`zip`/`gzip`/`tar`/`7z`…) and scripts are rejected from the response headers (`UNSUPPORTED_CONTENT_TYPE`) without downloading the body; unlabelled `application/octet-stream` bodies are sniffed on the first KB (PDF/HTML/text pass) |
| `respectRobotsTxt` | `true` | `WEBVECTOR_RESPECT_ROBOTS` | |
| `contentSignals` | `respect` | — | [Content Signals](https://contentsignals.org) etiquette: `Content-Signal: search=yes, ai-input=no, ai-train=no` in the matching robots.txt group (parsed from the raw file — most robots libraries drop unknown directives) or a `content-signal` response header. `respect` refuses pages that declare `ai-input=no` (`FETCH_BLOCKED_CONTENT_SIGNAL`, never retried) and records the signal on `doc.contentSignal` otherwise; `record` only records; `ignore` neither. Real-world hit rate is tiny (Stack Overflow sets `search=no, ai-train=no`, not `ai-input`), so recall is unaffected. |
| `userAgent` | `WebVector/<version> (+https://github.com/rthomas24/web-vector; user-directed research agent)` | `WEBVECTOR_USER_AGENT` | self-describing (no browser impersonation); robots.txt groups match on the `WebVector` token |
| `contactEmail` | — | `WEBVECTOR_CONTACT_EMAIL` | sent as the `From:` request header so site operators can contact whoever runs the agent |
| `retries` | `2` | — | on network errors / 408 / 429 / 5xx |
| `allowPrivateNetworks` | `false` | `WEBVECTOR_ALLOW_PRIVATE_NETWORKS` | disables the SSRF guard — only for trusted local setups |
| `parsers` | `[html, pdf, text]` | — | |
| `acceptMarkdown` | `prefer` | — | `prefer` sends `Accept: text/markdown, text/html;q=0.9, …` so sites that serve markdown to agents (Cloudflare "Markdown for Agents", Mintlify, Vercel docs) return 10–100× smaller bodies; `accept` lists markdown after HTML; `off` never asks. Served markdown skips Readability and goes through a cleaner that lifts frontmatter (`title`/`description`/`date`), drops MDX `import`/`export`/JSX and `[Skip to content]` links, and records `x-markdown-tokens` / `content-signal` into `doc.metadata` (`parser: 'server-markdown'`). The body is treated as untrusted text like any page. |
| `fastPaths` | `true` | `STACKEXCHANGE_KEY` / `GITHUB_TOKEN` (optional API keys) | URL-rewrite / API fast paths for hosts whose HTML is the worst way to get the content: `arxiv` (`/abs/{id}` → `/html/{id}`, then `/pdf/{id}`), `github-readme` (`github.com/o/r` → `raw.githubusercontent.com/o/r/HEAD/README.md`), `github-blob` (`/blob/ref/path` → raw), `github-issue` (`/issues|pull/{n}` → REST issue + comments), `google-docs` (`/document/d/{id}` → `export?format=md`), `npm` (`npmjs.com/package/x` → registry readme), `pypi` (`/project/x` → `/pypi/x/json`; currently robots-disallowed so it falls back), `hackernews` (`item?id=` → `hn.algolia.com/api/v1/items/{id}`, Firebase fallback; threaded markdown), `stackexchange` (`/questions/{id}` on stackoverflow.com / *.stackexchange.com → `api.stackexchange.com/2.3` question + answers, `## Question` / `### Answer (score N, accepted)` with a CC BY-SA attribution line). `false` disables all; a `string[]` of ids enables a subset. Rewritten hosts still pass robots.txt/SSRF/politeness; every attempt is `retries: 0` and any failure falls back to the original URL. `doc.url` stays the original for citations, `finalUrl` is the rewritten one, `doc.metadata.fastPath` names the path (`doc.fetchedFrom: 'api'` for API-rendered pages). API quotas are respected: SE `backoff`/`quota_remaining`, GitHub `x-ratelimit-remaining`, any 429 put the path on cooldown for the process. `registerFastPath()` from `webvector/ingest` adds your own. |
| `archiveFallback` | `false` | — | opt-in Wayback Machine fallback: `blocked` retries pages that failed with `FETCH_BLOCKED_BOT` / `FETCH_PAYMENT_REQUIRED` / HTTP 404–410 / `PARSE_NEEDS_JS` by asking `archive.org/wayback/available?url=…` and fetching `web.archive.org/web/{ts}id_/{url}` (raw snapshot) through the same guarded fetcher; `always` does so for any fetch failure except robots/SSRF/Content-Signal refusals. Etiquette: ≈1 request/s process-wide, a 429 from archive.org disables the fallback for 10 minutes, and snapshots that declare `isAccessibleForFree: false` are never used. Archived documents carry `doc.fetchedFrom: 'archive'`, `doc.archivedAt` (snapshot time) and `doc.metadata.archiveUrl` so citations can say so. |
| `chunkSize` / `chunkOverlap` | `480` / `60` | `WEBVECTOR_CHUNK_SIZE` / `WEBVECTOR_CHUNK_OVERLAP` | tokens |
| `maxChunksPerPage` / `minChunkChars` | `200` / `100` | — | |
| `useProviderContent` | `auto` | — | use page text returned by Tavily/Exa instead of fetching: `auto` only when it passes a quality gate (≥ 300 chars, not raw HTML, not truncated at a round provider cap such as 1000/2000/4000/8000 chars mid-sentence or a trailing ellipsis, not mostly links/nav lines) and otherwise fetches the page (`doc.parser: 'provider'` vs `'provider→fetch'`); `true` always trusts it (> 400 chars); `false` never |
| `cache.enabled` / `cache.ttlMs` / `cache.maxPages` | `true` / `900000` (15 min) / `500` | — | page cache: in-process LRU (`maxPages`) in front of the disk layer; past `ttlMs` a page is revalidated (ETag / Last-Modified → 304 = hit) or refetched. `0` = never expires. A longer `Cache-Control: max-age` from the origin extends freshness |
| `cache.dir` | `auto` | `WEBVECTOR_CACHE_DIR` (`auto`, a path, or `false`) | `auto` → `pages.sqlite` in `$XDG_CACHE_HOME/webvector` (`~/.cache/webvector`); a path → `pages.sqlite` there; `false` → memory only. Needs `node:sqlite` (Node ≥ 22.13, feature-detected); explicit dirs fall back to one JSON file per URL without it, `auto` falls back to memory. WAL + busy timeout: several processes (CLI + MCP) can share the file |
| `cache.maxDiskPages` / `cache.maxDiskBytes` | `20000` / `1073741824` (1 GiB) | — | disk budgets; least-recently-used pages are evicted first (`webvector cache stats\|prune\|clear` to inspect) |
| `cache.negativeTtlMs` | `15000` | — | remember robots-blocked / SSRF-blocked / 4xx URLs for this long (0 = off) |

## output / logging

| key | default | env | notes |
|---|---|---|---|
| `output.markdown` | `true` | `WEBVECTOR_OUTPUT_MARKDOWN` | include `result.markdown` |
| `output.maxPassageChars` | `1500` | — | per passage in the markdown (merged passages may use 2×) |
| `output.maxTokens` | `0` (off) | — | token budget for the rendered markdown; passages are packed by score per token (top passage and one per source first), omitted indices are listed in a footer; `maxOutputTokens` per call can only tighten it |
| `output.highlights` | `true` | — | compute `Passage.highlight` — the best 1–3 sentence window for the query (idf-weighted term coverage, + cosine when an embedder exists); code fences/tables are never cut |
| `output.evidenceCards` | `false` | — | one-line evidence-card header per passage: `**[n]** Title — <url> · domain · published … · corroborated by k other sites · matched: "sub-question" · score` (< 40 tokens) |
| `output.order` | `score` | — | `date-asc` orders passages oldest → newest (undated first; indices renumbered) so the freshest evidence sits closest to the answer |
| `output.passageMode` | `full` | — | `full` renders whole passages in the markdown; `highlight` renders only each passage's highlight window (~65 % fewer tokens on the eval) |
| `output.includeSnippetsOnFailure` | `true` | — | return search snippets when no page could be fetched (`degraded: 'search_only'`) |
| `output.format` | `detailed` | — | `concise` (passages + sources) or `detailed` (adds score/date, failures, stats). The MCP server defaults to `concise` (`--default-response-format`, per-call `response_format`) |
| `output.links` | `strip` | — | links inside rendered passages: `strip` (`[text](url)` → `text`, images → `[image: alt]`), `footnote` (`text[^k]` + per-passage footnotes), `inline`. Stored chunks never change |
| `output.deepLinks` | `false` | — | cite passages with text-fragment deep links `url#:~:text=start,end` (PDFs skipped) |
| `logging.level` | `warn` | `WEBVECTOR_LOG_LEVEL` | `silent` `error` `warn` `info` `debug` (stderr) |

Code-only: `logger` (`{ debug, info, warn, error }`), `fetch` (custom fetch implementation).

## telemetry

Nothing here sends data anywhere by itself.

| key | default | env | notes |
|---|---|---|---|
| `telemetry.pricing` | `false` | `WEBVECTOR_PRICING` | `true` adds `stats.usage.estimatedCostUsd` from a bundled list-price table (an **estimate**, labelled as such via `pricingNote`); an object overrides entries: `{ embed: { 'openai/text-embedding-3-small': 0.02 }, search: { brave: 5 }, rerank: { cohere: 2 } }` (USD per 1M tokens / per 1 000 calls). Table: `docs/pricing.json` |
| `telemetry.otel` | `false` | `WEBVECTOR_OTEL` | emit OpenTelemetry spans via `@opentelemetry/api` (optional peer: `npm i @opentelemetry/api`); WebVector never registers a provider/exporter, so spans are no-ops until your app sets up an SDK (NodeSDK / NodeTracerProvider with a context manager) |
| `telemetry.captureContent` | `false` | — | include the query (`webvector.query`) and full URLs (`url.full`) in span attributes; off = counts, hosts and ids only |

Span shape (GenAI semantic conventions, still "Development" upstream): `execute_tool webvector_research` (`gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`) → children `search <provider>`, `fetch <host>` (`server.address`, `webvector.fetch.cache: hit|revalidated|miss`, `error.type`), `embeddings <model>` (`gen_ai.operation.name=embeddings`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` ≈ chars/4), `rerank <provider>`, `retrieval` (`webvector.retrieve.*`). Query embeddings nest under `retrieval`.

### `stats.usage` and the `usage` event

Every `research()` / `fetchAndRetrieve()` result carries `stats.usage` (also emitted as `wv.on('usage', …)`):
`search: { provider, calls }`, `embed: { provider, model, requests, texts, tokens (≈ chars/4), cached }`, `rerank?: { provider, requests, documents }`,
`http: { requests, bytes, cacheHits, notModified, coalesced, negativeHits }` (also available as `stats.http`), and `estimatedCostUsd` / `pricingNote` when pricing is on.
`sources[].fromCache` / `sources[].revalidated` say where each page came from. `webvector search --stats` prints a one-line summary.

## Verifying citations (`wv.verifyCitations(answer, { sessionId | passages })` / `webvector verify`)

Deterministic quote-grounding check, no LLM: each sentence of an answer is classified against the passages its `[n]` markers cite (the latest `research()` result of a session, or an explicit `passages` array; whole pages are searched too while the session holds them) as `verbatim` (normalised substring), `paraphrase` (word-3-gram Jaccard ≥ 0.6 or ROUGE-L F1 ≥ 0.7 against the best 1–2 sentence window), `unsupported`, or `uncited` (no marker and no supporting passage). Numbers and dates absent from the sources are listed per sentence. Options: `jaccardThreshold`, `rougeThreshold`.

## Per-call options (`research(query, opts)` / tool arguments)

`relatedQueries` (`related_queries`), `topK` (`top_k`), `maxPages` (`max_pages`), `freshness`, `domainsAllow` (`domains_allow`), `domainsBlock` (`domains_block`), `sessionId` (`session_id`), `signal`, `onProgress`, `rerank`, `markdown`, `explain`, `autoRetry` (0/1), `maxOutputTokens` (packs passages into the budget and appends an "N more passages omitted" footer; `stats.retrieve.tokensReturned` reports the approximate size), `responseFormat`, `objective`, `category`, `deadlineMs`, `country`/`language`, `maxAgeMs`, `cacheMode`. Numeric limits are capped by the configured values above.
Cache policy per call (`research()`, `fetch()`, `fetchAndRetrieve()`; CLI `--max-age 2d`, `--no-cache`, `--cache-only`):

| option | effect |
|---|---|
| `maxAgeMs` | accept cached pages at most this old — overrides `ingestion.cache.ttlMs` and any `Cache-Control: max-age`; older copies are revalidated (ETag / Last-Modified → 304 reuses the parsed page) or refetched |
| `cacheMode: 'default'` | cache, revalidate when stale (default) |
| `cacheMode: 'bypass'` | always fetch (still writes the fresh page and skips the negative cache) |
| `cacheMode: 'readOnly'` | serve only from the cache, never touch the network; stale copies are fine, misses fail with `CACHE_MISS` (research degrades to search snippets) |

Concurrent identical page fetches (by canonical URL) and searches (provider + query + options) are coalesced into one request (`stats.usage.http.coalesced`); robots-blocked / SSRF-blocked / 4xx URLs are remembered for `ingestion.cache.negativeTtlMs` (default 15 s) so bursts of retries cost nothing.
