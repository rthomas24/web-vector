# WebVector

[![npm: webvector](https://img.shields.io/npm/v/webvector?label=webvector)](https://www.npmjs.com/package/webvector)
[![npm: webvector-mcp](https://img.shields.io/npm/v/webvector-mcp?label=webvector-mcp)](https://www.npmjs.com/package/webvector-mcp)
[![npm: webvector-cli](https://img.shields.io/npm/v/webvector-cli?label=webvector-cli)](https://www.npmjs.com/package/webvector-cli)
[![CI](https://github.com/rthomas24/web-vector/actions/workflows/ci.yml/badge.svg)](https://github.com/rthomas24/web-vector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Give your AI agent real web research in one tool call: search → read the full pages → rank → cited passages.**

Search tools hand a model titles and 150-character snippets, so it guesses the rest. Fetch tools hand it 40 KB of navigation and boilerplate, so it drowns. WebVector does the whole job in the middle: run the search, download and clean every result (HTML, PDF, Markdown), split it into passages, rank those passages against the question — semantically when an embedding model is available, lexically (BM25) when not — and return **only the passages that answer the query, each with its URL, title, offsets and score.**

- Works with **no API keys and no model download**: DuckDuckGo + BM25, ~12 MB install.
- Plug in any search backend, embedding provider, vector store or reranker (or write your own in one file).
- Ships as a **library**, an **MCP server** (Claude Code, Claude Desktop, Cursor, Windsurf, …) and a **CLI**.
- Polite and safe by default: robots.txt, per-host rate limits, SSRF guard, size/redirect/time caps, no telemetry.

```bash
npx -y webvector-cli search "what changed in the MCP spec in 2026?"
```

```
# Web research: what changed in the MCP spec in 2026?

**[1]** Streamable HTTP — Model Context Protocol — <https://modelcontextprotocol.io/specification/2026-07-28/…> (score 1.00)
> ### Earlier Streamable HTTP Revisions
> Protocol versions 2025-03-26 through 2025-11-25 also used the Streamable HTTP transport, but in a
> different shape: servers could assign a session via the Mcp-Session-Id header … None of these
> mechanisms are part of this revision.
…
## Sources
- Streamable HTTP — Model Context Protocol — <https://…> [1]
```

---

## Table of contents

1. [Try it in 30 seconds](#1-try-it-in-30-seconds)
2. [Use it as an MCP server (Claude Code, Claude Desktop, Cursor…)](#2-use-it-as-an-mcp-server)
3. [Use it as a library](#3-use-it-as-a-library)
4. [Use it from the command line](#4-use-it-from-the-command-line)
5. [The two tiers: lexical vs semantic](#5-the-two-tiers-lexical-vs-semantic)
6. [Configuration](#6-configuration)
7. [Providers](#7-providers)
8. [What you get back](#8-what-you-get-back)
9. [Errors and failures](#9-errors-and-failures)
10. [Security and etiquette](#10-security-and-etiquette)
11. [Run it from source (local development)](#11-run-it-from-source-local-development)
12. [Writing your own adapter](#12-writing-your-own-adapter)
13. [How it works](#13-how-it-works)
14. [Roadmap](#14-roadmap) · [License](#license)

Requirements: **Node.js ≥ 22.12** (Node 24 recommended). macOS, Linux and Windows.

---

## 1. Try it in 30 seconds

No install, no keys:

```bash
npx -y webvector-cli search "how does reciprocal rank fusion work" --stats
```

You'll see the passages, then a stats line like `search duckduckgo 957ms · pages 4/5 908ms · embed 0 chunks (none/bm25) · retrieve 10ms · total 1879ms`. `embed … none/bm25` means you're in the lexical tier (see §5) — the semantic tier switches on automatically once a model runtime or an embedding API key is present.

Check what your machine will use:

```bash
npx -y webvector-cli doctor
```

## 2. Use it as an MCP server

The MCP server exposes four tools — `webvector_research` (the main one), `webvector_fetch`, `webvector_search`, `webvector_status` — to any MCP client. (The pre-0.2 names `web_research`/`web_fetch`/`web_search` collided with Anthropic's built-in server tools and Claude Code's WebSearch/WebFetch; pass `--legacy-tool-names` to keep them as aliases for one release.)

**Claude Code**

```bash
claude mcp add webvector -- npx -y webvector-mcp
```

**Claude Desktop / Cursor / Windsurf / VS Code** — add to your MCP config (`claude_desktop_config.json`, `~/.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "webvector": {
      "command": "npx",
      "args": ["-y", "webvector-mcp"],
      "env": { "BRAVE_API_KEY": "optional — see §7" }
    }
  }
}
```

That's the lexical tier. For on-device semantic search, install the model runtime alongside:

```json
"args": ["-y", "-p", "@huggingface/transformers", "-p", "webvector-mcp", "webvector-mcp"]
```

…or simply put an embedding key in `env` (`OPENAI_API_KEY`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`, `COHERE_API_KEY`) and it upgrades itself.

**Over HTTP** (for agent frameworks): `npx -y webvector-mcp --http --port 3333` → `http://127.0.0.1:3333/mcp` (Streamable HTTP, localhost only). Add `--token <secret>` (or `WEBVECTOR_MCP_TOKEN`) to require `Authorization: Bearer <secret>`; binding to any other address needs `--host 0.0.0.0 --allow-remote --token …` and belongs behind TLS/your own auth. `GET /health` for liveness.

Every `webvector_research` result comes back both as compact Markdown (for the model — `response_format: concise|detailed`, trimmed to `max_tokens` with an explicit "N omitted" footer) and as slim `structuredContent` (for your app; `--structured full|off`), with progress notifications during the run. See [`packages/mcp/README.md`](packages/mcp/README.md) for every flag and argument.

## 3. Use it as a library

```bash
npm i webvector
```

```ts
import { WebVector } from 'webvector';

const wv = new WebVector();                                        // zero-config
const res = await wv.research('what is reciprocal rank fusion');

console.log(res.markdown);                                         // ready to drop into a prompt
for (const p of res.passages) console.log(p.score, p.citation);    // "[1] Title — https://…"
await wv.close();
```

Configure by passing options (see §6 for the full list):

```ts
const wv = new WebVector({
  search: { provider: 'brave' },                                   // reads BRAVE_API_KEY
  embeddings: { provider: 'openai', model: 'text-embedding-3-small' },
  retrieval: { topK: 8, rerank: 'cohere' },
  store: { mode: 'session' },                                      // reuse pages across calls
});

const res = await wv.research('How does Node 24 handle AbortSignal.any?', {
  relatedQueries: ['AbortSignal.any example'],  // extra angles (also searched)
  objective: 'whether composed signals leak',    // long-form intent: ranking only, never searched
  category: 'docs',                             // news | research | github | pdf | docs
  freshness: 'year',                            // day | week | month | year
  domainsAllow: ['nodejs.org', 'developer.mozilla.org'],
  sessionId: 'conversation-42',                 // pages already read this session are reused
  deadlineMs: 20_000,                           // partial results after 20 s (degraded: 'partial')
  responseFormat: 'concise',                    // markdown shape; see output.* config
  onProgress: (p) => console.error(p.stage, p.message),
});
```

Other calls: `wv.search(query)` (results only), `wv.fetch(url, { selector?, excludeSelectors?, includeLinks? })` (one page → Markdown, optionally a CSS-selected subtree, plus `links[]`), `wv.fetchAndRetrieve(url, query)` (one page → relevant passages), `wv.listSessions()`, `wv.clearSession(id)`.

**Give it to a model as a tool** — bindings for the popular SDKs are one import away:

```ts
// Vercel AI SDK
import { generateText, isStepCount } from 'ai';
import { webVectorTools } from 'webvector/ai-sdk';
await generateText({ model, tools: await webVectorTools(wv), stopWhen: isStepCount(5), prompt });

// Anthropic Messages API           // OpenAI Responses API            // LangChain.js
import { anthropicTools, runAnthropicTool } from 'webvector/anthropic';
//   runAnthropicTool(wv, name, input, { format: 'search_result' }) → search_result blocks (native citations)
//   anthropicTools({ maxUses: 5, allowedDomains: ['docs.python.org'] }) + the same opts on the runner = guardrails
import { openaiTools, runOpenAITool } from 'webvector/openai';
import { langchainTools } from 'webvector/langchain';

// Anything else: plain JSON Schema
import { webResearchToolDefinition } from 'webvector';
```

Runnable versions of each are in [`examples/`](examples).

## 4. Use it from the command line

```bash
npm i -g webvector-cli          # or keep using npx -y webvector-cli …

webvector search "query" [-k 8] [-p 12] [--provider brave] [--embeddings openai] [--rerank local] [--json|--md] [--stats] [--max-age 2h|--no-cache|--cache-only]
webvector fetch <url> [--query "…"]     # one page as Markdown, or just the passages relevant to --query (same cache flags)
webvector serp "query"                  # search results only
webvector verify "answer with [1] markers" --result r.json   # quote-grounding check against a `search --json` result
webvector doctor [--live] [--fix] [--json]   # config, dependencies, runtime (node:sqlite / SSRF guard), cache + store paths, local model presence
webvector cache stats|ls|clear|prune --older-than 7d   # the persistent page/embedding cache (~/.cache/webvector/pages.sqlite)
webvector init [--yes]                  # writes webvector.config.yaml (+ .env.example); interactive on a TTY
webvector config                        # print resolved config (secrets redacted)
webvector providers                     # every provider and the env var it reads
webvector mcp [--http]                  # run the MCP server
```

## 5. The two tiers: lexical vs semantic

One knob — `embeddings.provider`, default `auto` — decides how passages are ranked:

| Tier | Install | Ranking | Chosen when |
|---|---|---|---|
| **Lexical** (`none`) | ~12 MB, no downloads | BM25 over the full fetched pages + query expansion + per-source diversity | No model runtime and no embedding key are present (the plain `npx` path) |
| **Semantic** (`local`, `openai`, …) | + `@huggingface/transformers` (~230 MB, model 23 MB, fully offline) **or** any embedding API key | Hybrid: vectors + BM25 fused with RRF, MMR diversity, optional reranker | Automatically, as soon as either is available |

Upgrade any time: `npm i @huggingface/transformers` next to the package, or set a key. `webvector doctor` shows which tier is active. Lexical mode is a supported mode, not a fallback — results are marked `stats.embed.provider: 'none'` and are not "degraded".

## 6. Configuration

Precedence: **code** → **config file** → **environment variables** → **defaults**. Config files: `webvector.config.{ts,js,mjs,json,yaml,yml}`, `.webvectorrc`, or a `webvector` key in `package.json`, found by walking up from the working directory. `${VAR}` / `${VAR:-default}` inside values are filled from the environment.

`webvector init` writes a commented starter (with a JSON-Schema modeline for editor completions); here are the knobs people actually change:

```yaml
search:
  provider: duckduckgo          # duckduckgo | brave | serper | serpapi | google-cse | searxng | tavily | tavily-keyless | exa | perplexity | wikipedia
  fallbackProviders: [tavily-keyless, wikipedia]
  resultsPerQuery: 10
embeddings:
  provider: auto                # auto | none | local | openai | openai-compatible | gemini | voyage | cohere | mistral | jina | ollama
  model: Xenova/all-MiniLM-L6-v2   # local aliases: minilm (fast) | granite (quality) | embeddinggemma (best) | bge-small | nomic …
store:
  provider: memory              # memory | chroma | qdrant | pgvector
  mode: ephemeral               # ephemeral (per call) | session (reuse by sessionId, TTL) | persistent (external store)
retrieval:
  topK: 12
  hybrid: true                  # BM25 + vectors fused with RRF (semantic tier)
  queryExpansion: true          # heuristic (no LLM); pass retrieval.llm in code for LLM multi-query
  maxPerSource: 3
  mmr: true
  rerank: false                 # local | cohere | voyage | jina | llm
ingestion:
  maxPages: 10
  maxConcurrentFetches: 8
  timeoutMs: 15000
  totalDeadlineMs: 45000
  respectRobotsTxt: true
  chunkSize: 480                # tokens
output:
  markdown: true
  maxPassageChars: 1500
logging:
  level: warn
```

Environment equivalents: `WEBVECTOR_SEARCH_PROVIDER`, `WEBVECTOR_EMBEDDINGS_PROVIDER`, `WEBVECTOR_EMBEDDINGS_MODEL`, `WEBVECTOR_STORE_PROVIDER`, `WEBVECTOR_STORE_MODE`, `WEBVECTOR_TOP_K`, `WEBVECTOR_MAX_PAGES`, `WEBVECTOR_LOG_LEVEL`, `WEBVECTOR_MODEL_CACHE`, plus the provider keys below. Every option with its default: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## 7. Providers

Set the env var, name the provider, done. Details and gotchas per provider: [docs/PROVIDERS.md](docs/PROVIDERS.md).

| Search | env | Embeddings | env | Stores / Rerankers | env |
|---|---|---|---|---|---|
| `duckduckgo` (default) | — | `none` (BM25) | — | `memory` (default) | — |
| `brave` | `BRAVE_API_KEY` | `local` (Transformers.js) | — | `chroma` | `CHROMA_URL` |
| `serper` (Google) | `SERPER_API_KEY` | `openai` | `OPENAI_API_KEY` | `qdrant` | `QDRANT_URL` |
| `serpapi` | `SERPAPI_API_KEY` | `openai-compatible` (LM Studio, vLLM, …) | `OPENAI_COMPATIBLE_BASE_URL` | `pgvector` | `DATABASE_URL` |
| `tavily` / `tavily-keyless` | `TAVILY_API_KEY` | `gemini` | `GEMINI_API_KEY` | rerank `local` | — |
| `exa` | `EXA_API_KEY` | `voyage` | `VOYAGE_API_KEY` | rerank `cohere` | `COHERE_API_KEY` |
| `perplexity` | `PERPLEXITY_API_KEY` | `cohere` | `COHERE_API_KEY` | rerank `voyage` | `VOYAGE_API_KEY` |
| `searxng` (self-hosted) | `SEARXNG_URL` | `mistral` / `jina` / `ollama` | `MISTRAL_API_KEY` / `JINA_API_KEY` / `OLLAMA_HOST` | rerank `jina` | `JINA_API_KEY` |
| `wikipedia` | — | any Vercel AI SDK model | — | rerank `llm` (your function) | — |

If the primary search provider fails or is rate-limited, the `fallbackProviders` chain is tried automatically and every attempt is recorded in `stats.search.attempts`.

## 8. What you get back

```ts
interface ResearchResult {
  query: string; queries: string[];        // the query + expansions actually used
  passages: Passage[];                     // ranked; each: text, url, title, score (0–1), cosine?, bm25?,
                                           //   rerankScore?, chunkIndex, chunkCount? (merged neighbours),
                                           //   startOffset, endOffset, publishedAt?, fetchedAt, matchedQueries,
                                           //   highlight? { text, startOffset, endOffset } (best sentence window),
                                           //   corroboration? (distinct domains saying the same thing),
                                           //   citation "[n] Title — url (YYYY-MM-DD)"
  sources: SourceSummary[];                // one per page: status ok|failed|cached, chunks, bestScore, passageIndices, approxTokens, failure?
  failures: Failure[];                     // per-URL / per-stage problems with machine codes (never thrown)
  stats: { search, ingest, embed, retrieve, totalMs, warnings };   // timings + counts per stage
  markdown?: string;                       // the pre-rendered version above
  degraded?: 'search_only' | 'partial';    // e.g. every fetch failed → search snippets returned instead
  degradedReason?: string;                 // why (deadline reached, embeddings unavailable, …)
  coverage?: Record<string, number>;       // with relatedQueries: passages covering each sub-question
  evidence?: { level: 'strong'|'weak'|'none'; coverage; distinctDomains; topScoreRatio; cutoffPosition;
               suggestedQueries: string[] }; // LLM-free "is this enough?" verdict + what to search next
}
// stats.output = { chars, approxTokens } of the rendered markdown
```

## 9. Errors and failures

Two kinds, deliberately separate:

- **Failures** are per-page and never abort a run: `FETCH_TIMEOUT`, `FETCH_HTTP_ERROR`, `FETCH_BLOCKED_ROBOTS`, `FETCH_BLOCKED_SSRF`, `FETCH_BLOCKED_BOT` (anti-bot wall — Cloudflare/Akamai/DataDome/PerimeterX/Imperva, `details.vendor`, never retried), `FETCH_PAYMENT_REQUIRED` (HTTP 402 pay-per-crawl), `FETCH_BLOCKED_CONTENT_SIGNAL` (site declared `ai-input=no`), `FETCH_TOO_LARGE`, `TOO_MANY_REDIRECTS`, `UNSUPPORTED_CONTENT_TYPE`, `PARSE_EMPTY`, `PARSE_FAILED`. They land in `result.failures[]` and `sources[].failure`. If *every* page fails you still get the search snippets (`degraded: 'search_only'`, `ALL_FETCHES_FAILED`).
- **Errors** are thrown as `WebVectorError` with `code`, `message`, `remediation`, `retryable`, `provider`, `stage` and `toJSON()`; secrets are redacted. Examples: `MISSING_API_KEY` ("Set BRAVE_API_KEY … or use a keyless provider: duckduckgo"), `MISSING_DEPENDENCY` ("npm i @huggingface/transformers — or embeddings.provider: 'none'"), `SEARCH_BLOCKED`, `PROVIDER_RATE_LIMITED` (with `retryAfterMs`), `EMBEDDING_DIMENSION_MISMATCH` (names both models; suggests `store.clear()` or a new collection), `INVALID_CONFIG`.

## 10. Security and etiquette

WebVector fetches URLs chosen by a search engine — i.e. content an attacker can influence — so the fetcher is defensive by default:

- **SSRF guard**: private, loopback, link-local, CGNAT, multicast, reserved, IPv4-mapped-IPv6 and `localhost`/`*.internal` targets are refused; DNS answers are checked and every redirect hop is re-checked. Opt out only for trusted local setups (`ingestion.allowPrivateNetworks`).
- **Caps** on redirects (5), response size (5 MB), per-request time (15 s) and whole-run deadline (45 s); bounded concurrency globally and per host.
- **Etiquette**: robots.txt honoured (incl. `Crawl-delay` and [Content Signals](https://contentsignals.org) — `ai-input=no` is refused by default), identifiable User-Agent, per-host minimum interval, `Retry-After` respected; anti-bot challenge pages are recognised and never retried.
- **Parsing without execution**: HTML is parsed with linkedom (no scripts, no sub-resource loading), PDFs with pdf.js in no-eval mode; callers only ever receive Markdown/plain text with control characters stripped.
- **Secrets**: read from env/config, never logged; redacted in errors, in `webvector config`, and in the MCP `webvector_status` tool. The only files written are the page/embedding cache (`~/.cache/webvector/pages.sqlite`, set `ingestion.cache.dir: false` to keep everything in memory) and, if you choose `store.provider: sqlite`, the vector store (`~/.local/share/webvector/store.sqlite`).
- **No telemetry, ever.** (Opt-in OpenTelemetry *spans* via `telemetry.otel` go only to an SDK *you* register — nothing is bundled or sent by WebVector.)
- **MCP over HTTP** binds to `127.0.0.1` only, validates `Host`/`Origin` (DNS-rebinding protection), supports a bearer token, and refuses to bind elsewhere without `--allow-remote` **and** a token.
- **DNS rebinding is closed at connect time**: the SSRF check runs inside the DNS lookup used to open the socket, so the address checked is the address dialled.
- **DuckDuckGo note**: the keyless provider talks to DuckDuckGo's public HTML endpoints with a browser-like User-Agent (there is no official API). It is rate-limited and fragile by nature; heavy or commercial use should switch to a keyed provider (`brave`, `serper`, `tavily`). Page fetches always use the honest `WebVector/…` User-Agent.

Found something? Please open a private security advisory on GitHub rather than a public issue.

## 11. Run it from source (local development)

```bash
git clone https://github.com/rthomas24/web-vector
cd webvector
npm install                     # installs all workspaces (~1 min; includes the optional model runtime for tests)
npm run build                   # tsdown → packages/*/dist

# use the local build
node packages/cli/dist/cli.js search "reciprocal rank fusion" --stats
node packages/mcp/dist/bin.js                     # MCP server on stdio
node packages/mcp/dist/bin.js --http --port 3333  # …or HTTP

# point an MCP client at the local build
claude mcp add webvector-dev -- node /absolute/path/to/webvector/packages/mcp/dist/bin.js

# quality gates
npm test                        # unit tests, offline (mocked HTTP), ~5 s
npm run test:live               # real network + local model + MCP stdio round-trip (~20 s)
npm run lint                    # biome
npm run typecheck               # TypeScript 7
```

Repo layout and where to add things: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

To use the local build from another project without publishing: `npm pack` in `packages/core` (and `mcp`/`cli`) and `npm i ./webvector-0.1.0.tgz` there, or `npm link`.

## 12. Writing your own adapter

Every provider type is a small interface in [`packages/core/src/types.ts`](packages/core/src/types.ts) — `SearchProvider`, `EmbeddingProvider`, `VectorStore`, `ContentParser`, `Reranker`. Implement it, then either pass an instance in config or register a name so config files can use it:

```ts
import { customSearchProvider, registerSearchProvider, WebVector } from 'webvector';

const myIndex = customSearchProvider('my-index', async (query) => [
  { url: 'https://…', title: '…', snippet: '…' },
]);
new WebVector({ search: { instance: myIndex } });
// or: registerSearchProvider('my-index', (opts) => new MyProvider(opts));  → search.provider: my-index
```

`webvector/testing` exports conformance checks (`searchProviderConformance`, `embeddingProviderConformance`, `vectorStoreConformance`) you can drop into any test runner.

## 13. How it works

```
research(query)
  1. search      provider chain (DuckDuckGo → fallbacks) → dedupe by canonical URL → domain filters → top N
  2. ingest      concurrent, polite fetch → HTML (Readability→Markdown) | PDF | text → page cache
  3. chunk+embed markdown-aware recursive chunks with heading breadcrumbs → content-hash dedupe → embed (batched, cached)
  4. retrieve    query + expansions → vector top-k lists + BM25 top-k lists → weighted RRF → cosine cutoffs
                 → near-duplicate removal → per-source cap → MMR → optional rerank → top-k
  5. format      passages with citations, sources, failures, per-stage stats, Markdown
```

Typical run on a laptop: search ~1 s, 8 pages fetched + parsed ~1–2.5 s, retrieval < 50 ms → **~2 s lexical / ~4 s semantic**.

## 14. Roadmap

LanceDB and Pinecone stores · a headless-browser fetch adapter for JS-rendered pages · contextual-retrieval (LLM-summarised chunk context) as an opt-in · a standalone binary with no Node requirement · Python package sharing the conformance fixtures.

## License

MIT © Ryan Thomas
