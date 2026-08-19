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

Tools: `webvector_research` (query, related_queries?, top_k?, max_pages?, freshness?, domains_allow?, domains_block?, session_id?), `webvector_fetch` (url, query?), `webvector_search` (query), `webvector_status`. Progress notifications and `structuredContent` are supported; cancellation is honoured. `--legacy-tool-names` also registers the pre-0.2 names (`web_research`, `web_fetch`, `web_search`) as aliases for one release.

The server sends `instructions` (≤ 2 KB, phrased for the active lexical/semantic tier) that tell the model when to use research vs fetch vs search and how to phrase queries; Claude Code loads these plus the tool names at startup. Override with `--instructions-file <path>` or drop them with `--no-instructions`.

HTTP mode is localhost-only by default; `--token <t>` (or `WEBVECTOR_MCP_TOKEN`) requires a bearer token, and `--host 0.0.0.0 --allow-remote --token <t>` is needed to bind elsewhere (put TLS/auth in front).

Configure via environment (`WEBVECTOR_SEARCH_PROVIDER`, `WEBVECTOR_EMBEDDINGS_PROVIDER`, provider API keys, `WEBVECTOR_STORE_MODE=session`, …) or a `webvector.config.yaml` in the working directory. Programmatic use: `createWebVectorMcpServer()`, `serveWebVectorStdio()`, `serveWebVectorHttp()`.
