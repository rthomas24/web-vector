# WebVector

[![npm: webvector](https://img.shields.io/npm/v/webvector?label=webvector)](https://www.npmjs.com/package/webvector)
[![npm: webvector-mcp](https://img.shields.io/npm/v/webvector-mcp?label=webvector-mcp)](https://www.npmjs.com/package/webvector-mcp)
[![npm: webvector-cli](https://img.shields.io/npm/v/webvector-cli?label=webvector-cli)](https://www.npmjs.com/package/webvector-cli)
[![CI](https://github.com/rthomas24/web-vector/actions/workflows/ci.yml/badge.svg)](https://github.com/rthomas24/web-vector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Web research for AI agents in one call: search → read the full pages → rank → cited passages.**
No API keys, no model download, ~12 MB. Ships as an **MCP server**, a **library** and a **CLI**.

```bash
npx -y webvector-cli search "what changed in the MCP spec in 2026?"
```

```
**[1]** Streamable HTTP — Model Context Protocol — <https://modelcontextprotocol.io/specification/2026-07-28/…>
> Protocol versions 2025-03-26 through 2025-11-25 also used the Streamable HTTP transport, but in a
> different shape: servers could assign a session via the Mcp-Session-Id header … None of these
> mechanisms are part of this revision.
## Sources
- Streamable HTTP — Model Context Protocol — <https://…> [1]
```

## Run it

**MCP server** (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Zed …):

```bash
claude mcp add webvector -- npx -y webvector-mcp
```
```json
{ "mcpServers": { "webvector": { "command": "npx", "args": ["-y", "webvector-mcp"] } } }
```

**Library:**

```ts
import { WebVector } from 'webvector';
const wv = new WebVector();
const res = await wv.research('reciprocal rank fusion k constant', { relatedQueries: ['RRF formula'] });
console.log(res.markdown);          // cited passages, ready for a prompt
console.log(res.evidence?.level);   // 'strong' | 'weak' | 'none' + suggestedQueries
```

**CLI:** `npm i -g webvector-cli` → `webvector search "…" -k 8`, `webvector fetch <url> --query "…"`, `webvector doctor`.

**Semantic tier (optional):** `npm i @huggingface/transformers` (local ONNX embeddings, offline) *or* set `OPENAI_API_KEY` / `VOYAGE_API_KEY` / `GEMINI_API_KEY` … — ranking upgrades from BM25 to hybrid automatically. `webvector doctor` shows the active tier.

## What it does

| Capability | Example |
|---|---|
| **One-call research** — search, fetch every result (HTML, PDF, served Markdown), chunk, rank, cite | `wv.research(q)` · MCP `webvector_research` · `webvector search q` |
| **Hybrid ranking that works keyless** — BM25F (title/heading/body fields, proximity, identifiers like `AbortSignal.any`), vectors when available, relative-score fusion, per-source/domain diversity, adjacent-chunk merge | `retrieval.bm25.*`, `retrieval.fusion`, `retrieval.maxPerDomain` |
| **Sub-questions covered** — pass `related_queries`; xQuAD-style selection guarantees every aspect gets passages | `{ relatedQueries: ['UDP connectionless', 'TCP handshake'] }` → `res.coverage` |
| **Evidence gate + follow-ups** — LLM-free verdict (`strong / weak / none`), suggested queries, optional one in-call retry | `res.evidence`, `{ autoRetry: 1 }`, MCP `auto_retry` |
| **Highlights, token budgets, deep links** — best sentence per passage, packing into `max_tokens` with an explicit "N omitted" footer, `url#:~:text=` citations, `#page=N` for PDFs | `output.passageMode: 'highlight'`, `max_tokens`, `output.deepLinks` |
| **Verify citations** — classify each sentence of an answer as verbatim / paraphrase / unsupported against the cited passages; flags numbers not in the source | `wv.verifyCitations(answer, { sessionId })` · MCP `webvector_verify` · `webvector verify` |
| **Read one page well** — pagination (`start_index`), CSS `selector`, link lists, query-focused passages | MCP `webvector_fetch` · `wv.fetch(url, { selector })` |
| **Fetch more pages, cleaner** — markdown-first content negotiation (10–100× smaller on docs sites), fast paths (arXiv HTML, GitHub README/issues, Hacker News & Stack Exchange APIs, Google Docs), extractor ensemble with a recall guard, JS-shell detection (`PARSE_NEEDS_JS`) + optional render hook, `__NEXT_DATA__` recovery, boilerplate suppression | `ingestion.acceptMarkdown`, `ingestion.fastPaths`, `ingestion.html.strategy`, `ingestion.render` |
| **Fast on repeat** — SQLite page cache with ETag revalidation (second run: 0 requests), persistent embedding cache, single-flight, per-call `max_age_ms` / `cache_mode` | `~/.cache/webvector/pages.sqlite`, `webvector cache stats` |
| **Sessions & stores** — pages read once are reused across calls; memory / `sqlite` / Chroma / Qdrant / pgvector | `store.mode: session`, `store.provider: sqlite` |
| **Providers** — 11 search (DuckDuckGo default, Brave, Serper, Tavily, Exa, SearXNG …), 9 embedding, 5 rerankers, custom in one function | [`docs/PROVIDERS.md`](docs/PROVIDERS.md) |
| **Agent-ready MCP** — namespaced tools, ≤2 KB instructions, concise/detailed output, `depth` presets, `objective`, sessions, `--max-uses` / `--allowed-domains` guardrails, `research` & `verify_claim` prompts; adapters for Anthropic (`search_result` blocks), OpenAI, Vercel AI SDK, LangChain | [`packages/mcp`](packages/mcp/README.md) |
| **Polite & safe** — robots.txt + `Content-Signal`, per-host pacing, honest UA, SSRF guard, bot-wall detection (never retried), size/time caps, no telemetry, secrets redacted | [`SECURITY.md`](SECURITY.md) |
| **Measured** — offline eval over 32 recorded cases + 40-fixture extraction corpus run in CI; ranking changes are gated on it | `npm run eval` · [`eval/`](eval/README.md) |

## Configure

Zero config works. Otherwise `webvector.config.yaml` (with editor autocomplete via `$schema`) or `WEBVECTOR_*` env vars — every key in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md). `webvector init` writes a starter file.

## Docs

[Full guide](docs/GUIDE.md) · [Configuration](docs/CONFIGURATION.md) · [Providers](docs/PROVIDERS.md) · [Architecture](docs/ARCHITECTURE.md) · [MCP server](packages/mcp/README.md) · [CLI](packages/cli/README.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Eval](eval/README.md)

## Develop

```bash
git clone https://github.com/rthomas24/web-vector && cd web-vector
npm install && npm run build && npm test && npm run eval
```

Requires Node ≥ 22.12. MIT © Ryan Thomas.
