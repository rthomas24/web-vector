# Provider setup guide

Every provider is selected by name in config (`search.provider`, `embeddings.provider`, `store.provider`, `retrieval.rerank`) or via `WEBVECTOR_*` env vars, and reads its credentials from the conventional env var listed below (or `apiKey`/`url` in config). `webvector providers` prints this table; `webvector doctor --live` verifies connectivity.

## Search

| name | key / url env | notes |
|---|---|---|
| `duckduckgo` (default) | — | Keyless HTML endpoints; header rotation + challenge detection; may rate-limit heavy use → `SEARCH_BLOCKED` (retryable, triggers fallbacks). Options: `search.options.region` (`us-en`, `wt-wt`). |
| `tavily` / `tavily-keyless` | `TAVILY_API_KEY` (optional) | Keyless mode is rate-limited but real. Returns `raw_content` which the pipeline uses instead of fetching (`ingestion.useProviderContent`). Free key: 1,000 credits/month. |
| `brave` | `BRAVE_API_KEY` | Independent index; freshness, country, `extra_snippets`. Requires a card on file ($5/mo credit, then $5/1k). |
| `serper` (alias `google`) | `SERPER_API_KEY` | Google results, 2,500 free credits, no card. Domain filters via `site:` operators. |
| `serpapi` | `SERPAPI_API_KEY` | Google via SerpAPI (250 free/month). |
| `google-cse` | `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | Legacy — closed to new customers, EOL 2027-01-01. |
| `exa` | `EXA_API_KEY` | Neural search; returns page text (used as provider content). `search.options.type: fast|auto|deep`. |
| `perplexity` | `PERPLEXITY_API_KEY` | Perplexity Search API ($5/1k). |
| `searxng` | `SEARXNG_URL` | Self-hosted metasearch. Enable `search.formats: [html, json]` and allow-list your client in `limiter.toml`. `docker run -p 8080:8080 searxng/searxng`. |
| `wikipedia` | — | Keyless REST search; used as the last fallback. |
| custom | — | `customSearchProvider(id, async (query, opts) => [{ url, title, snippet? }])` or `registerSearchProvider(name, factory)`. |

Fallback chain (default `[tavily-keyless, wikipedia]`) is tried when the primary throws or returns nothing; every attempt is recorded in `stats.search.attempts`.

## Embeddings

`embeddings.provider` defaults to **`auto`**: `local` if `@huggingface/transformers` is installed → else the first of openai/voyage/gemini/cohere/mistral/jina with a key in the environment → else `none`.

| name | key / url env | default model | notes |
|---|---|---|---|
| `none` / `lexical` | — | — | **Lexical tier**: no embeddings, no downloads (~12 MB install). Ranking = BM25 over the full fetched pages + query expansion + per-source diversity. Not "degraded" — a supported mode. `store.provider` is ignored (nothing to store). |
| `local` | — (needs `npm i @huggingface/transformers`, ~230 MB) | `Xenova/all-MiniLM-L6-v2` (384d, q8, ~23 MB) | Aliases: `minilm`/`fast`, `granite`/`quality` (8k ctx, better BEIR), `embeddinggemma`/`best`, `bge-small`, `arctic-s`, `nomic`, `mxbai`, `e5-small`, `multilingual-e5-small`. `embeddings.dtype: q8|fp32`, `device: cpu|coreml|cuda`, cache in `WEBVECTOR_MODEL_CACHE` (default `~/.cache/webvector/models`). Query/document prefixes per model applied automatically. |
| `openai` | `OPENAI_API_KEY` | `text-embedding-3-small` | `embeddings.dimensions` for MRL truncation. Batches ≤2048 inputs / ~280k tokens. |
| `openai-compatible` (alias `lmstudio`) | `OPENAI_COMPATIBLE_BASE_URL` (+ optional key) | — | LM Studio, Ollama `/v1`, vLLM, TEI, OpenRouter, Together, DeepInfra, Azure. `embeddings.baseUrl: http://127.0.0.1:1234/v1`. |
| `gemini` (alias `google`) | `GEMINI_API_KEY` | `gemini-embedding-2` | 8k ctx, dims 128–3072 (`embeddings.dimensions: 768` recommended). `gemini-embedding-001` also supported (taskType). Batches of 100. |
| `voyage` | `VOYAGE_API_KEY` | `voyage-4-lite` | `voyage-4`, `voyage-4-large`, `voyage-3.5`…; `input_type` query/document handled. |
| `cohere` | `COHERE_API_KEY` | `embed-v4.0` | `input_type` search_query/search_document; batches of 96. |
| `mistral` | `MISTRAL_API_KEY` | `mistral-embed` | |
| `jina` | `JINA_API_KEY` | `jina-embeddings-v3` | `task: retrieval.query|retrieval.passage`. |
| `ollama` | `OLLAMA_HOST` (default `http://127.0.0.1:11434`) | `nomic-embed-text` | `ollama pull nomic-embed-text`; prefixes for nomic/arctic/embeddinggemma applied. |
| Vercel AI SDK | — | — | `fromAiSdkEmbeddingModel(openai.embedding('…'), { queryProviderOptions, documentProviderOptions })` from `webvector/ai-sdk`. |
| custom | — | — | `customEmbeddingProvider(id, model, async (texts, kind) => vectors, { dimensions })`. |

Never mix models within one persistent store: `EMBEDDING_DIMENSION_MISMATCH` names both models and suggests `store.clear()` or a new `store.collection`.

## Vector stores

| name | url env | notes |
|---|---|---|
| `memory` (default) | — | Brute-force cosine over Float32; per-call (ephemeral) or per-session with TTL/LRU (`store.mode: session`). |
| `chroma` | `CHROMA_URL` (default `http://localhost:8000`) / `CHROMA_API_KEY` for Cloud | `npm i chromadb`; local server: `npx chroma run --path ./.chroma` or `docker run -p 8000:8000 chromadb/chroma`. Cosine space set automatically. |
| `qdrant` | `QDRANT_URL` (default `http://localhost:6333`) / `QDRANT_API_KEY` | `npm i @qdrant/js-client-rest`; `docker run -p 6333:6333 qdrant/qdrant` or Qdrant Cloud free tier. |
| `pgvector` (alias `postgres`) | `DATABASE_URL` / `PGVECTOR_URL` | `npm i pg pgvector`; creates `<collection>` table + HNSW cosine index (halfvec above 2000 dims). Works with Neon/Supabase. |
| custom | — | `registerVectorStore(name, factory)` implementing `VectorStore` (`init`, `upsert`, `query`, `has?`, `clear`). |

## Rerankers (`retrieval.rerank`)

| name | key env | default model |
|---|---|---|
| `local` | — (needs `@huggingface/transformers`) | `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder |
| `cohere` | `COHERE_API_KEY` | `rerank-v4.0-fast` |
| `voyage` | `VOYAGE_API_KEY` | `rerank-2.5-lite` |
| `jina` | `JINA_API_KEY` | `jina-reranker-v3` |
| `llm` | — | listwise prompt via `retrieval.llm` (`(prompt) => Promise<string>`) |
| AI SDK | — | `fromAiSdkRerankingModel(cohere.reranking('rerank-v3.5'))` |

`retrieval.rerankApiKey` / `retrieval.rerankModel` override the defaults; `retrieval.rerankTopN` (50) caps how many candidates are sent.

## Query expansion

Default (no LLM): keyword form, pseudo-relevance-feedback terms from top titles/snippets, top-result title, plus a pseudo-document vector blended into the query. Optional LLM multi-query: pass `retrieval.llm` (any `(prompt) => Promise<string>`, e.g. `llmFromAiSdk(model)`). Agent-supplied `related_queries` are additionally *searched* (not just retrieved) to widen the page set.
