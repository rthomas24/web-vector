# Architecture (for contributors)

WebVector is a small monorepo. Read this top-down and you will know where everything lives.

```
packages/
  core/   npm "webvector"       the library — everything below
  mcp/    npm "webvector-mcp"   MCP server wrapping the library (stdio + Streamable HTTP)
  cli/    npm "webvector-cli"   `webvector` command wrapping the library
examples/                       runnable integration snippets (AI SDK, Anthropic, OpenAI, LangChain, MCP)
docs/                           CONFIGURATION.md (every option), PROVIDERS.md (setup per provider), ARCHITECTURE.md (this file)
```

## The pipeline, one call

`WebVector.research(query)` runs five stages. Each has its own file under `packages/core/src/pipeline/`:

| Stage | File | What it does |
|---|---|---|
| wiring | `components.ts` | Builds the search stack, embedder (or none), store, fetcher, parsers, caches, expander, reranker from config |
| 1 search | `search-stage.ts` | Runs the query (+ related queries) through the provider chain, merges + dedupes results |
| 2+3 ingest | `ingest-stage.ts` | For one page: chunk → dedupe by content hash → embed (cached) → upsert → BM25 index |
| 4 retrieve | `retrieve-stage.ts` | Vector lists + BM25 lists → weighted RRF → cutoffs → dedupe → per-source cap → MMR → rerank → passages |
| 5 format | `format.ts` | Markdown rendering with citations |
| orchestration | `webvector.ts` | The `WebVector` class: config, lifecycle, `research()`, `fetch()`, `search()`, sessions |

Supporting pieces: `session.ts` (per-session store + BM25 index + TTL registry), `tool.ts` (tool name/description/zod schemas → JSON Schema for any function-calling API).

## Providers (all behind small interfaces in `types.ts`)

```
src/search/       SearchProvider     duckduckgo.ts (keyless HTML), brave.ts, google.ts (Serper/SerpAPI/CSE),
                                     providers.ts (Tavily/Exa/Perplexity/SearXNG/Wikipedia/custom),
                                     index.ts (registry + FallbackSearchProvider chain)
src/embeddings/   EmbeddingProvider  hosted.ts (OpenAI/compatible/Gemini/Voyage/Cohere/Mistral/Jina/Ollama),
                                     local.ts (Transformers.js presets), base.ts (batching/retry/cache), index.ts (registry + auto)
src/stores/       VectorStore        memory.ts (brute-force cosine), external.ts (Chroma/Qdrant/pgvector), index.ts
src/rerankers/    Reranker           cohere/voyage/jina/local cross-encoder/LLM listwise
src/ingest/       fetcher.ts (polite + SSRF-guarded fetch), ssrf.ts, robots.ts, parsers.ts (HTML/PDF/text → Markdown), chunker.ts
src/retrieval/    bm25.ts, fusion.ts (RRF/MMR/dedupe/diversify), expansion.ts (heuristic + LLM query expansion)
src/config/       schema.ts (zod, defaults), env.ts (WEBVECTOR_* + provider keys), index.ts (file loading, precedence, redaction)
src/integrations/ ai-sdk.ts, anthropic.ts, openai.ts, langchain.ts — thin bindings over tool.ts
src/util/         concurrency, hashing, url canonicalisation, vector math, LRU, logger, events, http helper
src/testing/      conformance checks for third-party adapters
```

Adding a provider = implement the interface in one file, register it in the directory's `index.ts`, add its env var to `config/env.ts`, and (if it needs a heavy package) load it with `importOptional()` so it stays an optional peer dependency.

## Design rules

- **Never throw for one bad page.** Per-URL problems become `failures[]`; only config/auth/embedding-provider errors abort a run.
- **Optional deps are lazy.** `@huggingface/transformers`, `chromadb`, `@qdrant/js-client-rest`, `pg`, `ai`, … are imported inside the adapter that needs them, with a `MISSING_DEPENDENCY` error naming the `npm i` command.
- **Two tiers.** With no embedder (`embeddings.provider: 'none'`) everything still works on BM25; with one, retrieval is hybrid.
- **Everything is dependency-injectable.** Any stage accepts instances via `WebVectorConfig` (`search.instance`, `embeddings.instance`, `store.instance`, `retrieval.reranker/expander/llm`, `fetch`, `logger`), which is also how the tests run fully offline.
- **Errors carry a `code` and a `remediation`.** See `errors.ts`.

## Testing

`npm test` — unit tests with mocked HTTP (msw), fully offline, ~5 s. `npm run test:live` — real network + local model + MCP round-trip; provider-specific tests auto-skip without their key.
