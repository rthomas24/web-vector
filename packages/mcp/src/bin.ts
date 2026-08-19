#!/usr/bin/env node
/**
 * webvector-mcp — stdio by default; `--http [--port 3333] [--host 127.0.0.1] [--path /mcp]`.
 * Configuration comes from webvector.config.* / environment variables (see README).
 */
import { serveWebVectorHttp, serveWebVectorStdio } from './index.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : 'true';
};

if (args.includes('--help') || args.includes('-h')) {
  console.error(`webvector-mcp — MCP server for WebVector

Usage:
  webvector-mcp                 stdio transport (for Claude Desktop, Claude Code, Cursor, …)
  webvector-mcp --http          Streamable HTTP on http://127.0.0.1:3333/mcp (localhost only)
     [--port N] [--path /mcp] [--token T | WEBVECTOR_MCP_TOKEN=T]
     [--host H --allow-remote --token T]   expose beyond localhost — put TLS/auth in front

Configuration (env or webvector.config.yaml):
  WEBVECTOR_SEARCH_PROVIDER      duckduckgo (default) | brave | serper | tavily | exa | perplexity | searxng | …
  WEBVECTOR_EMBEDDINGS_PROVIDER  auto (default) | none (lexical BM25) | local | openai | gemini | voyage | cohere | mistral | jina | ollama
    auto = local model if @huggingface/transformers is installed, else a provider with a key, else lexical.
    Semantic search: npx -y -p @huggingface/transformers -p webvector-mcp webvector-mcp   (or set OPENAI_API_KEY etc.)
  BRAVE_API_KEY / SERPER_API_KEY / TAVILY_API_KEY / OPENAI_API_KEY / …
  WEBVECTOR_STORE_MODE           ephemeral (default) | session | persistent
Run \`npx webvector-cli doctor\` to diagnose configuration.`);
  process.exit(0);
}

if (args.includes('--http')) {
  const port = Number(flag('--port') ?? process.env.PORT ?? 3333);
  // Deliberately NOT process.env.HOST: PaaS images often set HOST=0.0.0.0, which would silently expose the server.
  const host = flag('--host') ?? '127.0.0.1';
  const path = flag('--path') ?? '/mcp';
  const allowRemote = args.includes('--allow-remote');
  const token = flag('--token') ?? process.env.WEBVECTOR_MCP_TOKEN;
  serveWebVectorHttp({ port, host, path, allowRemote, token: token === 'true' ? undefined : token })
    .then(({ close }) => {
      const shutdown = () => void close().finally(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[webvector-mcp] failed to start HTTP server:', err);
      process.exit(1);
    });
} else {
  // Anything a dependency prints with console.log would corrupt the JSON-RPC stream on stdout.
  console.log = (...a: unknown[]) => console.error(...a);
  const handle = serveWebVectorStdio();
  const shutdown = () => void Promise.resolve(handle.close()).finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.error('[webvector-mcp] serving on stdio');
}
