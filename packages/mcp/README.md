# webvector-mcp

MCP server that gives any agent **real web research in one tool call**: search the web, read the full pages, rank them, return only the relevant, cited passages. Zero config, no API keys, ~12 MB. Built on the MCP TypeScript SDK v2 (stdio + Streamable HTTP).

## Install

```bash
claude mcp add webvector -- npx -y webvector-mcp        # Claude Code
```
```json
{ "mcpServers": { "webvector": { "command": "npx", "args": ["-y", "webvector-mcp"] } } }
```
Claude Desktop, Cursor, Windsurf, VS Code (`.vscode/mcp.json` uses `servers`), Zed, Gemini CLI, Goose all take the shape above. Semantic tier (optional): `npx -y -p @huggingface/transformers -p webvector-mcp webvector-mcp` (local ONNX embeddings, offline) — or set `OPENAI_API_KEY` / `VOYAGE_API_KEY` / `GEMINI_API_KEY` … and it upgrades itself. `npx -y webvector-mcp --http` serves `http://127.0.0.1:3333/mcp`.

## Tools

| Tool | Use it when | Key args |
|---|---|---|
| `webvector_research` | you need facts, numbers, quotes or code from the web (search → read pages → cited passages) | `query`, `related_queries`, `top_k`, `max_pages`, `freshness`, `domains_allow/block`, `depth: fast\|balanced\|thorough`, `objective`, `category`, `max_tokens`, `response_format`, `auto_retry`, `session_id`, `deadline_ms`, `max_age_ms`, `cache_mode` |
| `webvector_fetch` | you already have the URL | `url`, `query` (only relevant passages), `max_length` + `start_index` (pagination), `include_links`, `selector`, `exclude_selectors` |
| `webvector_search` | you only want the result list | `query` |
| `webvector_verify` | before finalising an answer with `[n]` citations | `answer`, `session_id` or `passages` → verbatim / paraphrase / unsupported per sentence, numbers not in source |
| `webvector_status` | diagnostics | — |

Prompts: `research(topic, focus?)` and `verify_claim(claim, context?)` (`/mcp__webvector__research …` in Claude Code). Server `instructions` (≤ 2 KB) tell the model when to use which tool and how to phrase queries for the active tier.

## What the model gets

- **Concise by default**: `[n] Title — url` + quoted passage, a Sources list with "(N more chunks; …)" hints, suggested follow-up queries; `response_format: detailed` adds scores/dates/failures/timings.
- **Token budget honoured**: `max_tokens` (default 4000) packs passages by score per token, keeps one per source, and says exactly what was left out: `_3 more passages omitted (indices 10–12). Call again with max_tokens ≥ 6000 or webvector_fetch(url, query) for [10]._`
- **Evidence gate**: structured `evidence.level` (`strong|weak|none`) and `coverage` per sub-question; `auto_retry: 1` runs one more search round in the same call when evidence is weak.
- **Errors that teach**: zero passages is not an error — the text says what to try (drop freshness, remove domain filters, 2–3 `related_queries`, or `webvector_search`); `structuredContent.hint/retryable`; rate limits show retry-in and keyed alternatives; URL-shaped domain filters are corrected.
- **Sessions**: pages already read are reused automatically (one process-wide session on stdio; over HTTP an opaque `session_id` is returned and accepted back). `--session-mode off` disables minting.
- **Long pages**: `webvector_fetch` paginates on paragraph boundaries with a continuation sentence and `{truncated,totalChars,approxTokens,nextStartIndex}`; declares `_meta["anthropic/maxResultSizeChars"]` so Claude Code keeps results in context.
- **Links & citations**: links inside passages are stripped to text (`output.links: strip|footnote|inline`), images become `[image: alt]`; `output.deepLinks` cites `url#:~:text=…`, PDFs `#page=N`.
- **Progress**: `fetched 5/8 pages (2 failed) · embedding`; `deadline_ms` always returns partial results with the reason.

## Operator controls

| Flag / env | Effect |
|---|---|
| `--max-uses N` (`WEBVECTOR_MCP_MAX_USES`) | in-band `MAX_USES_EXCEEDED` after N calls |
| `--allowed-domains a,b` / `--blocked-domains a,b` (`WEBVECTOR_MCP_ALLOWED_DOMAINS` / `…_BLOCKED_DOMAINS`) | applied to search, research and fetch |
| `--user-location US[,en]` (`WEBVECTOR_MCP_USER_LOCATION`) | search country/language |
| `--max-tokens`, `--fetch-max-length`, `--default-response-format`, `--structured slim\|full\|off`, `--max-deadline-ms` | output shape and budgets |
| `--tools research,fetch` | expose a subset |
| `--instructions-file <path>` / `--no-instructions` | replace or drop the server instructions |
| `--legacy-tool-names` | also register `web_research`/`web_fetch`/`web_search` (pre-0.2 names) for one release |
| `--http [--port 3333] [--token t]`; `--host 0.0.0.0 --allow-remote --token t` | HTTP mode (loopback by default; a bearer token is required to bind elsewhere) |

Configure the pipeline (providers, keys, cache, store) via `WEBVECTOR_*` env vars or a `webvector.config.yaml` in the working directory — see [Configuration](https://github.com/rthomas24/web-vector/blob/main/docs/CONFIGURATION.md). Long calls in Claude Code: set a per-server `"timeout"` (ms) in `.mcp.json` (thorough depth budgets 60 s).

Programmatic: `createWebVectorMcpServer(opts)`, `serveWebVectorStdio()`, `serveWebVectorHttp()`. Registry: `package.json` carries `mcpName: "io.github.rthomas24/webvector"` and `server.json` for the official MCP Registry.

Part of [WebVector](https://github.com/rthomas24/web-vector) — library [`webvector`](https://www.npmjs.com/package/webvector), CLI [`webvector-cli`](https://www.npmjs.com/package/webvector-cli). Node ≥ 22.12, MIT.
