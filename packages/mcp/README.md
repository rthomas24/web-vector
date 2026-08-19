# webvector-mcp

MCP server for [WebVector](https://github.com/rthomas24/web-vector): gives any MCP client a `webvector_research` tool that searches the web, reads the full pages, ranks them and returns only the relevant, cited passages. Zero-config and ~12 MB (DuckDuckGo + lexical BM25 ranking). Built on the MCP TypeScript SDK v2.

```bash
npx -y webvector-mcp            # stdio, lexical tier (no downloads beyond the package)
npx -y webvector-mcp --http     # Streamable HTTP on http://127.0.0.1:3333/mcp
# semantic tier: local ONNX embeddings, fully offline (~230 MB runtime + 23 MB model, once)
npx -y -p @huggingface/transformers -p webvector-mcp webvector-mcp
# …or set OPENAI_API_KEY / VOYAGE_API_KEY / GEMINI_API_KEY / COHERE_API_KEY and it upgrades automatically
```

Claude Code: `claude mcp add webvector -- npx -y webvector-mcp`

Claude Desktop / Cursor / Windsurf / VS Code (`mcp.json`):
```json
{ "mcpServers": { "webvector": { "command": "npx", "args": ["-y", "webvector-mcp"], "env": { "BRAVE_API_KEY": "optional" } } } }
```

Tools: `webvector_research` (query, related_queries?, top_k?, max_pages?, freshness?, domains_allow?, domains_block?, session_id?, response_format?, max_tokens?, depth?, objective?, category?, deadline_ms?), `webvector_fetch` (url, query?, max_length?, start_index?, include_links?, selector?, exclude_selectors?, response_format?), `webvector_search` (query), `webvector_status`. Progress notifications and `structuredContent` are supported; cancellation is honoured. `--legacy-tool-names` also registers the pre-0.2 names (`web_research`, `web_fetch`, `web_search`) as aliases for one release.

Output shape: `response_format: concise` (default) prints `[n] Title — url` + passage text, a Sources list (with "(N more chunks; …)" hints for sources with unread depth) and suggested follow-up queries — no per-passage score/date, no "Not fetched" section unless every page failed, no stats; `detailed` restores those. Results are trimmed to `max_tokens` (500–20000, default 4000 or `--max-tokens` / `WEBVECTOR_MCP_MAX_TOKENS`) with an explicit footer: `_3 more passages omitted (indices 10–12). Call again with max_tokens ≥ 6000 or webvector_fetch(url, query) for [10]._`. `structuredContent` is slim by default (query, passages[{index,url,title,text,score,publishedAt}], sources[{url,title,status,chunks}], degraded, session_id, suggested_queries, omitted); `--structured full` returns the whole `ResearchResult`, `--structured off` none. Links inside passages are stripped to their text (`output.links: strip|footnote|inline`), images become `[image: alt]`; `output.deepLinks: true` cites with `url#:~:text=…` fragments.

`webvector_fetch` pages long content: `max_length` (chars, default 20000, `--fetch-max-length`) + `start_index`, sliced on a paragraph/heading boundary, with a continuation sentence (`Content truncated at char A of B. Call webvector_fetch with start_index=A to continue, or pass query …`) and `{truncated, totalChars, approxTokens, nextStartIndex}` in `structuredContent`; the tool declares `_meta["anthropic/maxResultSizeChars"]` so Claude Code keeps results in context. `include_links` appends a deduped link list (same-host first, ≤ 150; `links[]` structured); `selector` converts only the matching CSS subtree (bypassing Readability), `exclude_selectors` drops nodes first.

Follow-ups and errors that teach: pages already read are reused automatically — on stdio every call shares one process-wide session; over HTTP the result carries an opaque `session_id` (`_session_id: wv_… — pass it back to reuse these pages._`) to send back on the next call; `--session-mode off` disables minting (a `store.mode: session|persistent` config reuses pages anyway). Zero passages is **not** an error: the text says what to try next (drop freshness, remove domain filters, 2–3 `related_queries` with synonyms, or `webvector_search`), and `structuredContent` carries `hint` / `retryable`. Rate limits show a retry-in and keyed alternatives; URL-shaped domain filters are auto-corrected to bare hosts (or rejected with the correct form); a freshness filter the active provider ignores adds a warning line. `depth: fast|balanced|thorough` presets pages/passages/expansion/deadline (numeric args override; the server's configured limits are never exceeded). `objective` (≤ 2000 chars) is used for ranking only, `category: news|research|github|pdf|docs` maps to query operators (`filetype:pdf`, `site:github.com`, …). `deadline_ms` always returns partial results (`degraded: "partial"` + reason). Progress notifications read `fetched 5/8 pages (2 failed) · embedding`.

Guardrails (operator-side, in-band errors): `--max-uses N` (`MAX_USES_EXCEEDED` after the budget), `--allowed-domains a,b` / `--blocked-domains a,b` (search, research and fetch), `--user-location US[,en]` (search country/language) — env `WEBVECTOR_MCP_MAX_USES` / `WEBVECTOR_MCP_ALLOWED_DOMAINS` / `WEBVECTOR_MCP_BLOCKED_DOMAINS` / `WEBVECTOR_MCP_USER_LOCATION`. The same options exist on the adapters (`anthropicTools({ maxUses, allowedDomains })` documents the policy, `runAnthropicTool(..., { maxUses, allowedDomains })` enforces it).

Prompts: `research` (topic, focus?) and `verify_claim` (claim, context?) — `/mcp__webvector__research …` in Claude Code, prompt pickers in Claude Desktop, Cursor, VS Code, Zed, Gemini CLI, Goose. `tools/list` is deterministic (prompt-cache friendly). Long calls: set a per-server `"timeout"` (ms) in `.mcp.json` for Claude Code — the default `depth: thorough` budget is 60 s; e.g. `{ "mcpServers": { "webvector": { "command": "npx", "args": ["-y", "webvector-mcp"], "timeout": 120000 } } }`.

Registry: `package.json` carries `mcpName: "io.github.rthomas24/webvector"` and `server.json` describes the npm/stdio package for the official MCP Registry (`mcp-publisher publish` after `npm publish`; not wired into CI yet).

The server sends `instructions` (≤ 2 KB, phrased for the active lexical/semantic tier) that tell the model when to use research vs fetch vs search and how to phrase queries; Claude Code loads these plus the tool names at startup. Override with `--instructions-file <path>` or drop them with `--no-instructions`.

HTTP mode is localhost-only by default; `--token <t>` (or `WEBVECTOR_MCP_TOKEN`) requires a bearer token, and `--host 0.0.0.0 --allow-remote --token <t>` is needed to bind elsewhere (put TLS/auth in front).

Configure via environment (`WEBVECTOR_SEARCH_PROVIDER`, `WEBVECTOR_EMBEDDINGS_PROVIDER`, provider API keys, `WEBVECTOR_STORE_MODE=session`, …) or a `webvector.config.yaml` in the working directory. Programmatic use: `createWebVectorMcpServer()`, `serveWebVectorStdio()`, `serveWebVectorHttp()`.
