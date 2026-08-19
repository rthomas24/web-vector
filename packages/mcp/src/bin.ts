#!/usr/bin/env node
/**
 * webvector-mcp — stdio by default; `--http [--port 3333] [--host 127.0.0.1] [--path /mcp]`.
 * Configuration comes from webvector.config.* / environment variables (see README).
 */
import { readFileSync } from 'node:fs';
import { parseUserLocation } from 'webvector';
import { type CreateServerOptions, serveWebVectorHttp, serveWebVectorStdio } from './index.js';

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
  --legacy-tool-names           also expose web_research / web_fetch / web_search as aliases (one release)
  --instructions-file <path>    replace the built-in server instructions (≤ 2 KB; Claude Code truncates there)
  --no-instructions             send no server instructions
  --default-response-format concise|detailed   markdown shape unless the call passes response_format (default concise)
  --structured off|slim|full    how much structuredContent to return next to the text (default slim)
  --max-tokens N                default token budget per result, 500–20000 (default 4000; env WEBVECTOR_MCP_MAX_TOKENS)
  --fetch-max-length N          default max_length for webvector_fetch in chars (default 20000)
  --session-mode auto|off       auto (default): stdio shares one process-wide session; HTTP mints a session_id per call
  --max-uses N                  refuse further web tool calls after N (in-band MAX_USES_EXCEEDED; env WEBVECTOR_MCP_MAX_USES)
  --allowed-domains a,b         only search/fetch these domains (env WEBVECTOR_MCP_ALLOWED_DOMAINS)
  --blocked-domains a,b         never search/fetch these domains (env WEBVECTOR_MCP_BLOCKED_DOMAINS)
  --user-location US[,en]       search country / language passthrough (env WEBVECTOR_MCP_USER_LOCATION)
  --max-deadline-ms N           cap for per-call deadline_ms

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

const instructionsFile = flag('--instructions-file');
const enumFlag = <T extends string>(
  name: string,
  allowed: readonly T[],
  env?: string,
): T | undefined => {
  const v = flag(name) ?? (env ? process.env[env] : undefined);
  if (v === undefined || v === 'true') return undefined;
  if (!allowed.includes(v as T)) {
    console.error(`[webvector-mcp] ${name} must be one of ${allowed.join('|')} (got "${v}")`);
    process.exit(2);
  }
  return v as T;
};
const numFlag = (name: string, env?: string): number | undefined => {
  const v = flag(name) ?? (env ? process.env[env] : undefined);
  return v && v !== 'true' && Number.isFinite(Number(v)) ? Number(v) : undefined;
};
const listFlag = (name: string, env?: string): string[] | undefined => {
  const v = flag(name) ?? (env ? process.env[env] : undefined);
  if (!v || v === 'true') return undefined;
  const items = v
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
};
const maxTokensRaw = flag('--max-tokens') ?? process.env.WEBVECTOR_MCP_MAX_TOKENS;
const serverOptions: CreateServerOptions = {
  legacyToolNames: args.includes('--legacy-tool-names'),
  defaultResponseFormat: enumFlag(
    '--default-response-format',
    ['concise', 'detailed'] as const,
    'WEBVECTOR_MCP_RESPONSE_FORMAT',
  ),
  structured: enumFlag(
    '--structured',
    ['off', 'slim', 'full'] as const,
    'WEBVECTOR_MCP_STRUCTURED',
  ),
  maxOutputTokens:
    maxTokensRaw && maxTokensRaw !== 'true' && Number.isFinite(Number(maxTokensRaw))
      ? Number(maxTokensRaw)
      : undefined,
  fetchMaxLength: numFlag('--fetch-max-length', 'WEBVECTOR_MCP_FETCH_MAX_LENGTH'),
  sessionMode: enumFlag('--session-mode', ['auto', 'off'] as const, 'WEBVECTOR_MCP_SESSION_MODE'),
  maxDeadlineMs: numFlag('--max-deadline-ms', 'WEBVECTOR_MCP_MAX_DEADLINE_MS'),
  guardOptions: {
    maxUses: numFlag('--max-uses', 'WEBVECTOR_MCP_MAX_USES'),
    allowedDomains: listFlag('--allowed-domains', 'WEBVECTOR_MCP_ALLOWED_DOMAINS'),
    blockedDomains: listFlag('--blocked-domains', 'WEBVECTOR_MCP_BLOCKED_DOMAINS'),
    userLocation: parseUserLocation(
      (() => {
        const v = flag('--user-location') ?? process.env.WEBVECTOR_MCP_USER_LOCATION;
        return v && v !== 'true' ? v : undefined;
      })(),
    ),
  },
  instructions: args.includes('--no-instructions')
    ? false
    : instructionsFile && instructionsFile !== 'true'
      ? readFileSync(instructionsFile, 'utf8').trim()
      : undefined,
};

if (args.includes('--http')) {
  const port = Number(flag('--port') ?? process.env.PORT ?? 3333);
  // Deliberately NOT process.env.HOST: PaaS images often set HOST=0.0.0.0, which would silently expose the server.
  const host = flag('--host') ?? '127.0.0.1';
  const path = flag('--path') ?? '/mcp';
  const allowRemote = args.includes('--allow-remote');
  const token = flag('--token') ?? process.env.WEBVECTOR_MCP_TOKEN;
  serveWebVectorHttp({
    ...serverOptions,
    port,
    host,
    path,
    allowRemote,
    token: token === 'true' ? undefined : token,
  })
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
  const handle = serveWebVectorStdio(serverOptions);
  const shutdown = () => void Promise.resolve(handle.close()).finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.error('[webvector-mcp] serving on stdio');
}
