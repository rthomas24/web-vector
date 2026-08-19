/**
 * webvector-mcp — MCP server exposing WebVector as tools:
 *   webvector_research  search → read full pages → embed → cited passages (the main tool)
 *   webvector_fetch     one URL → Markdown (optionally query-focused passages)
 *   webvector_search    SERP only
 *   webvector_status    resolved config, provider health, sessions
 * The pre-0.2 names (web_research/web_fetch/web_search) are available as aliases behind
 * `--legacy-tool-names` for one release.
 *
 * Built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`). Works over stdio
 * (`npx -y webvector-mcp`) and stateless Streamable HTTP (`webvector-mcp --http`).
 */
import {
  McpServer,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  LEGACY_TOOL_NAMES,
  redactConfig,
  renderMarkdown,
  toResearchOptions,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_TOOL_NAME,
  WEB_RESEARCH_DESCRIPTION,
  WEB_RESEARCH_TOOL_NAME,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  WebVector,
  type WebVectorConfig,
  WebVectorError,
  webFetchInputSchema,
  webResearchInputSchema,
  webResearchOutputSchema,
  webSearchInputSchema,
} from 'webvector';
import { z } from 'zod';
import { buildInstructions, resolveTier, type Tier } from './instructions.js';

export {
  buildInstructions,
  MAX_INSTRUCTIONS_BYTES,
  resolveTier,
  type Tier,
} from './instructions.js';

export const VERSION = '0.1.0';

export interface CreateServerOptions {
  /** Shared WebVector instance (recommended: one per process so caches/sessions persist across requests). */
  webvector?: WebVector;
  config?: WebVectorConfig;
  /** Approx token budget for markdown returned to the model (default 4000). */
  maxOutputTokens?: number;
  /** Which tools to expose (default all). Legacy names (`web_research`, …) are accepted here too. */
  tools?: (
    | 'webvector_research'
    | 'webvector_fetch'
    | 'webvector_search'
    | 'webvector_status'
    | 'web_research'
    | 'web_fetch'
    | 'web_search'
  )[];
  /**
   * Also register the pre-0.2 tool names (`web_research`, `web_fetch`, `web_search`) as aliases of the
   * namespaced tools. Off by default: those names collide with Anthropic's built-in server tools and
   * Claude Code's WebSearch/WebFetch. Kept for one release.
   */
  legacyToolNames?: boolean;
  /**
   * Server instructions sent to clients (Claude Code loads these + tool names at startup). Default:
   * built for the active tier (see `buildInstructions`). Pass `false` to send none.
   */
  instructions?: string | false;
  /** Retrieval tier used to phrase the default instructions (default: detected from config/env). */
  tier?: Tier;
  /** Server name/version reported to clients. */
  name?: string;
  version?: string;
}

/** Lazily create a shared WebVector from config/env (one per process). */
let shared: Promise<WebVector> | undefined;
export function getSharedWebVector(config?: WebVectorConfig): Promise<WebVector> {
  if (!shared) shared = WebVector.create(config ?? {});
  return shared;
}

function errorResult(err: unknown) {
  const e = WebVectorError.from(err, { code: 'INTERNAL' });
  return {
    content: [{ type: 'text' as const, text: `Error (${e.code}): ${e.describe()}` }],
    isError: true,
    structuredContent: { error: e.toJSON() },
  };
}

/**
 * Create a configured McpServer. Pass to `serveStdio(() => createWebVectorMcpServer(opts))` or
 * `createMcpHandler(() => createWebVectorMcpServer(opts))`.
 */
export function createWebVectorMcpServer(opts: CreateServerOptions = {}): McpServer {
  const tools = new Set(
    (
      opts.tools ?? [
        WEB_RESEARCH_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
        'webvector_status',
      ]
    ).map((t) => LEGACY_TOOL_NAMES[t] ?? t),
  );
  const instructions =
    opts.instructions === false
      ? undefined
      : (opts.instructions ??
        buildInstructions({
          tier: opts.tier ?? resolveTier(opts.webvector ?? opts.config),
          tools: {
            research: tools.has(WEB_RESEARCH_TOOL_NAME),
            fetch: tools.has(WEB_FETCH_TOOL_NAME),
            search: tools.has(WEB_SEARCH_TOOL_NAME),
          },
        }));
  const server = new McpServer(
    { name: opts.name ?? 'webvector', version: opts.version ?? VERSION },
    instructions ? { instructions } : undefined,
  );
  const legacyNames = new Map<string, string>(
    Object.entries(LEGACY_TOOL_NAMES).map(([legacy, c]) => [c, legacy]),
  );
  /** Register a tool and, when enabled, its legacy alias (same config/handler; alias appended after the canonical tools). */
  const aliases: (() => void)[] = [];
  const register = <In extends StandardSchemaWithJSON, Out extends StandardSchemaWithJSON>(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: In;
      outputSchema?: Out;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<In>,
  ) => {
    server.registerTool(name, config, cb);
    const legacy = legacyNames.get(name);
    if (opts.legacyToolNames && legacy) {
      aliases.push(() =>
        server.registerTool(
          legacy,
          { ...config, title: `${config.title ?? name} (alias of ${name})` },
          cb,
        ),
      );
    }
  };
  const wvp = () =>
    opts.webvector ? Promise.resolve(opts.webvector) : getSharedWebVector(opts.config);
  const maxTokens = opts.maxOutputTokens ?? 4000;

  if (tools.has(WEB_RESEARCH_TOOL_NAME)) {
    register(
      WEB_RESEARCH_TOOL_NAME,
      {
        title: 'Web research (search → read pages → cited passages)',
        description: WEB_RESEARCH_DESCRIPTION,
        inputSchema: webResearchInputSchema,
        outputSchema: webResearchOutputSchema,
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (args, ctx) => {
        try {
          const wv = await wvp();
          const progressToken = ctx.mcpReq._meta?.progressToken;
          const notify =
            progressToken === undefined
              ? undefined
              : async (progress: number, total: number, message: string) => {
                  try {
                    await ctx.mcpReq.notify({
                      method: 'notifications/progress',
                      params: { progressToken, progress, total, message },
                    });
                  } catch {
                    /* ignore */
                  }
                };
          let step = 0;
          const res = await wv.research(
            args.query,
            toResearchOptions(args, {
              signal: ctx.mcpReq.signal,
              maxOutputTokens: maxTokens,
              onProgress: notify
                ? (p) => void notify(++step, 100, `${p.stage}: ${p.message}`)
                : undefined,
            }),
          );
          const text = renderMarkdown(res, { maxTokens, untrustedNotice: true });
          const { markdown: _md, ...structured } = res;
          return {
            content: [{ type: 'text', text }],
            structuredContent: JSON.parse(JSON.stringify(structured)),
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  if (tools.has(WEB_FETCH_TOOL_NAME)) {
    register(
      WEB_FETCH_TOOL_NAME,
      {
        title: 'Fetch a URL as Markdown',
        description: WEB_FETCH_DESCRIPTION,
        inputSchema: webFetchInputSchema,
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (args, ctx) => {
        try {
          const wv = await wvp();
          if (args.query) {
            const res = await wv.fetchAndRetrieve(args.url, args.query, {
              topK: args.top_k,
              signal: ctx.mcpReq.signal,
            });
            const { markdown: _md, ...structured } = res;
            return {
              content: [{ type: 'text', text: res.markdown ?? renderMarkdown(res) }],
              structuredContent: JSON.parse(JSON.stringify(structured)),
            };
          }
          const doc = await wv.fetch(args.url, { signal: ctx.mcpReq.signal });
          const max = args.max_chars ?? 40_000;
          const md =
            doc.markdown.length > max
              ? `${doc.markdown.slice(0, max)}\n\n…(truncated, ${doc.markdown.length} chars total)`
              : doc.markdown;
          return {
            content: [{ type: 'text', text: `# ${doc.title}\n<${doc.url}>\n\n${md}` }],
            structuredContent: {
              url: doc.url,
              title: doc.title,
              contentType: doc.contentType,
              publishedAt: doc.publishedAt,
              siteName: doc.siteName,
              lang: doc.lang,
              chars: doc.markdown.length,
              truncated: doc.markdown.length > max,
            },
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  if (tools.has(WEB_SEARCH_TOOL_NAME)) {
    register(
      WEB_SEARCH_TOOL_NAME,
      {
        title: 'Web search (SERP only)',
        description: WEB_SEARCH_DESCRIPTION,
        inputSchema: webSearchInputSchema,
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (args, ctx) => {
        try {
          const wv = await wvp();
          const results = await wv.search(args.query, {
            count: args.count,
            freshness: args.freshness,
            domainsAllow: args.domains_allow,
            domainsBlock: args.domains_block,
            signal: ctx.mcpReq.signal,
          });
          const text =
            results
              .map(
                (r) => `${r.rank}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
              )
              .join('\n') || 'No results.';
          return { content: [{ type: 'text', text }], structuredContent: { results } };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  if (tools.has('webvector_status')) {
    server.registerTool(
      'webvector_status',
      {
        title: 'WebVector status',
        description:
          'Show the resolved WebVector configuration (secrets redacted), active providers, and research sessions. Useful for debugging.',
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async () => {
        try {
          const wv = await wvp();
          const sessions = await wv.listSessions();
          const status = {
            version: VERSION,
            config: redactConfig(wv.config),
            // Counts only: session ids are client-chosen and must not leak between clients.
            sessions: {
              count: sessions.length,
              chunks: sessions.reduce((n, s) => n + s.chunks, 0),
            },
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
            structuredContent: status,
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  // Deterministic tools/list order: canonical tools first, then legacy aliases (prompt-cache friendly).
  for (const add of aliases) add();
  return server;
}

export interface StdioOptions extends CreateServerOptions {}

/** Serve over stdio (the `npx -y webvector-mcp` path). Returns the handle; call `.close()` to stop. */
export function serveWebVectorStdio(opts: StdioOptions = {}) {
  return serveStdio(async () => createWebVectorMcpServer(await resolveServerOptions(opts)));
}

/**
 * Resolve the shared WebVector once per process (config file + env, no model load) so the
 * instructions/tier are computed once and stay static across requests.
 */
export async function resolveServerOptions<T extends CreateServerOptions>(opts: T): Promise<T> {
  const webvector = opts.webvector ?? (await getSharedWebVector(opts.config));
  const tier = opts.tier ?? resolveTier(webvector);
  return { ...opts, webvector, tier };
}

export interface HttpOptions extends CreateServerOptions {
  port?: number;
  host?: string;
  /**
   * Bearer token required on the MCP endpoint (`Authorization: Bearer <token>`). Mandatory when
   * binding to a non-loopback address; recommended always when other local users share the machine.
   */
  token?: string;
  path?: string;
  /** Allow non-localhost Host/Origin headers (only when you front it with your own auth/proxy). */
  allowRemote?: boolean;
}

/** Serve stateless Streamable HTTP on `http://host:port/mcp`. Returns the node http.Server. */
export async function serveWebVectorHttp(opts: HttpOptions = {}) {
  const [
    { createMcpHandler },
    { toNodeHandler, localhostHostValidation, localhostOriginValidation },
    http,
  ] = await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/node'),
    import('node:http'),
  ]);
  const resolved = await resolveServerOptions(opts);
  const handler = createMcpHandler(() => createWebVectorMcpServer(resolved));
  const nodeHandler = toNodeHandler(handler);
  const hostGuard = localhostHostValidation();
  const originGuard = localhostOriginValidation();
  const path = opts.path ?? '/mcp';
  const host = opts.host ?? '127.0.0.1';
  const loopback = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(host);
  if (!loopback && !opts.allowRemote) {
    throw new Error(
      `Refusing to bind MCP HTTP server to non-loopback address ${host} without --allow-remote (and a --token).`,
    );
  }
  if (opts.allowRemote && !opts.token) {
    throw new Error('--allow-remote requires a bearer token (--token or WEBVECTOR_MCP_TOKEN).');
  }
  const { timingSafeEqual } = await import('node:crypto');
  const tokenOk = (req: import('node:http').IncomingMessage) => {
    if (!opts.token) return true;
    const h = req.headers.authorization ?? '';
    const given = h.startsWith('Bearer ') ? h.slice(7) : '';
    const a = Buffer.from(given);
    const b = Buffer.from(opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'webvector-mcp', version: VERSION }));
      return;
    }
    if (url.pathname !== path) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Not found. MCP endpoint is ${path}`);
      return;
    }
    if (!opts.allowRemote) {
      if (!hostGuard(req, res)) return;
      if (!originGuard(req, res)) return;
    }
    if (!tokenOk(req)) {
      res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' });
      res.end('Unauthorized');
      return;
    }
    void nodeHandler(req, res);
  });
  const port = opts.port ?? 3333;
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.error(`[webvector-mcp] Streamable HTTP listening on http://${host}:${port}${path}`);
  const close = () =>
    new Promise<void>((resolve) => {
      handler.close().finally(() => server.close(() => resolve()));
    });
  return { server, close, url: `http://${host}:${port}${path}` };
}
