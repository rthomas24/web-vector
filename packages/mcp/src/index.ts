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

import { randomBytes } from 'node:crypto';
import {
  McpServer,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  DEFAULT_FETCH_MAX_LENGTH,
  LEGACY_TOOL_NAMES,
  type ProgressEvent,
  type ResearchResult,
  type ResponseFormat,
  redactConfig,
  renderResearch,
  runFetchTool,
  suggestedQueriesFor,
  ToolGuard,
  type ToolGuardOptions,
  toResearchOptions,
  toSlimOutput,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_TOOL_NAME,
  WEB_RESEARCH_DESCRIPTION,
  WEB_RESEARCH_TOOL_NAME,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  WEBVECTOR_STATUS_DESCRIPTION,
  WEBVECTOR_STATUS_TOOL_NAME,
  WebVector,
  type WebVectorConfig,
  webFetchInputSchema,
  webResearchInputSchema,
  webResearchOutputSchema,
  webResearchSlimOutputSchema,
  webSearchInputSchema,
} from 'webvector';
import { z } from 'zod';
import { buildInstructions, resolveTier, type Tier } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { argumentError, errorResult, NO_PASSAGES_HINT, validateDomains } from './results.js';

export {
  buildInstructions,
  MAX_INSTRUCTIONS_BYTES,
  resolveTier,
  type Tier,
} from './instructions.js';
export { PROMPTS, registerPrompts } from './prompts.js';
export { errorResult, hintFor, NO_PASSAGES_HINT, validateDomains } from './results.js';

export const VERSION = '0.1.0';

export type StructuredMode = 'off' | 'slim' | 'full';
/** `_meta["anthropic/maxResultSizeChars"]` for webvector_fetch (Claude Code caps at 500k). */
export const FETCH_MAX_RESULT_SIZE_CHARS = 250_000;
export const DEFAULT_MAX_TOKENS = 4000;
export const MIN_MAX_TOKENS = 500;
export const MAX_MAX_TOKENS = 20_000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function researchOutputSchema(mode: StructuredMode): StandardSchemaWithJSON | undefined {
  if (mode === 'full') return webResearchOutputSchema;
  if (mode === 'slim') return webResearchSlimOutputSchema;
  return undefined;
}

/** structuredContent for a research-shaped result according to the server's `--structured` mode. */
function structuredResearch(
  mode: StructuredMode,
  res: ResearchResult,
  extra: Parameters<typeof toSlimOutput>[1] = {},
): { structuredContent?: Record<string, unknown> } {
  if (mode === 'off') return {};
  if (mode === 'slim') return { structuredContent: toSlimOutput(res, extra) };
  const { markdown: _md, ...rest } = res;
  return {
    structuredContent: JSON.parse(JSON.stringify({ ...rest, session_id: extra.session_id })),
  };
}

export interface CreateServerOptions {
  /** Shared WebVector instance (recommended: one per process so caches/sessions persist across requests). */
  webvector?: WebVector;
  config?: WebVectorConfig;
  /**
   * Default approx token budget for markdown returned to the model (default 4000, env
   * `WEBVECTOR_MCP_MAX_TOKENS`); per-call `max_tokens` (500–20000) overrides. Stays under Claude
   * Code's 10k-token output warning by default.
   */
  maxOutputTokens?: number;
  /** Default `max_length` for webvector_fetch when the call omits it (default 20000 chars). */
  fetchMaxLength?: number;
  /** Default `response_format` for research/fetch results (default `concise`). */
  defaultResponseFormat?: ResponseFormat;
  /**
   * How much `structuredContent` to return next to the text: `slim` (default — query, passages,
   * sources, degraded, session_id, suggested_queries), `full` (the whole ResearchResult) or `off`.
   */
  structured?: StructuredMode;
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
  /**
   * `auto` (default): on stdio every call without session_id shares one process-wide session so
   * pages already read are reused; over HTTP a session_id is minted per call and returned in the
   * result for the client to pass back. `off`: never mint (core `store.mode` still applies).
   */
  sessionMode?: 'auto' | 'off';
  /** Set by the serve helpers; drives the session strategy (default `stdio`). */
  transport?: 'stdio' | 'http';
  /** Operator guardrails: max uses, allowed/blocked domains, user location (see ToolGuard). */
  guardOptions?: ToolGuardOptions;
  /** Share one guard across servers/requests (HTTP mode: one per process). Default: built from guardOptions. */
  guard?: ToolGuard;
  /** Cap for per-call `deadline_ms` (ms). Default: the core `ingestion.totalDeadlineMs` cap applies. */
  maxDeadlineMs?: number;
  /** Server name/version reported to clients. */
  name?: string;
  version?: string;
}

/** One process-wide session id (stdio: one client per process). */
let processSession: string | undefined;
export function processSessionId(): string {
  processSession ??= `wv_${randomBytes(6).toString('base64url')}`;
  return processSession;
}

/** Progress text like "fetched 5/8 pages (2 failed) · embedding". */
export function progressMessage(e: ProgressEvent): string {
  switch (e.stage) {
    case 'search':
      return e.done ? `search: ${e.message}` : `searching…`;
    case 'ingest':
      if (e.done === 0) return `fetching ${e.total} pages…`;
      return `fetched ${e.done}/${e.total} pages${e.failed ? ` (${e.failed} failed)` : ''}${e.done < e.total ? ' · embedding' : ''}`;
    case 'retrieve':
      return e.done ? `retrieved: ${e.message}` : 'ranking passages…';
    default:
      return `${e.stage}: ${e.message}`;
  }
}

/** Lazily create a shared WebVector from config/env (one per process). */
let shared: Promise<WebVector> | undefined;
export function getSharedWebVector(config?: WebVectorConfig): Promise<WebVector> {
  if (!shared) shared = WebVector.create(config ?? {});
  return shared;
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
        WEBVECTOR_STATUS_TOOL_NAME,
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
  const defaultMaxTokens = clamp(
    opts.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    MIN_MAX_TOKENS,
    MAX_MAX_TOKENS,
  );
  const defaultFormat: ResponseFormat = opts.defaultResponseFormat ?? 'concise';
  const structured: StructuredMode = opts.structured ?? 'slim';
  const guard = opts.guard ?? new ToolGuard(opts.guardOptions ?? {});
  const transport = opts.transport ?? 'stdio';
  const sessionMode = opts.sessionMode ?? 'auto';
  const deadlineCap = opts.maxDeadlineMs;

  /**
   * Server-minted sessions (SEP-2567 style: opaque handle as a plain tool arg). stdio = one client
   * → one process-wide session so follow-ups reuse pages; HTTP = mint per call and hand the id back.
   * `store.mode: session|persistent` already reuse pages, so nothing is minted then.
   */
  const sessionFor = (wv: WebVector, requested: string | undefined) => {
    if (requested) return { id: requested, minted: false };
    if (sessionMode === 'off' || wv.config.store.mode !== 'ephemeral')
      return { id: undefined, minted: false };
    if (transport === 'http')
      return { id: `wv_${randomBytes(6).toString('base64url')}`, minted: true };
    return { id: processSessionId(), minted: false };
  };
  const progressNotifier = (ctx: Parameters<ToolCallback<typeof webResearchInputSchema>>[1]) => {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    if (progressToken === undefined) return undefined;
    let last = '';
    return (e: ProgressEvent) => {
      const message = progressMessage(e);
      if (message === last) return;
      last = message;
      void ctx.mcpReq
        .notify({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress:
              e.stage === 'ingest' ? e.done : e.stage === 'retrieve' && e.done ? e.total : 0,
            total: e.stage === 'ingest' || e.stage === 'retrieve' ? e.total : undefined,
            message,
          },
        })
        .catch(() => {});
    };
  };
  let freshnessSupported: boolean | undefined;
  const checkFreshness = async (wv: WebVector, freshness: unknown): Promise<string | undefined> => {
    if (!freshness) return undefined;
    freshnessSupported ??= (await wv.capabilities()).search.supportsFreshness;
    return freshnessSupported
      ? undefined
      : `_Note: the active search provider ignores freshness; results are not date-filtered._`;
  };

  if (tools.has(WEB_RESEARCH_TOOL_NAME)) {
    register(
      WEB_RESEARCH_TOOL_NAME,
      {
        title: 'Web research (search → read pages → cited passages)',
        description: WEB_RESEARCH_DESCRIPTION,
        inputSchema: webResearchInputSchema,
        outputSchema: researchOutputSchema(structured),
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (args, ctx) => {
        try {
          const allow = validateDomains('domains_allow', args.domains_allow);
          if (!allow.ok) return argumentError('INVALID_ARGUMENT', allow.message, allow.hint);
          const block = validateDomains('domains_block', args.domains_block);
          if (!block.ok) return argumentError('INVALID_ARGUMENT', block.message, block.hint);
          guard.consume();
          const wv = await wvp();
          const input = guard.applyDomains({
            ...args,
            domains_allow: allow.domains,
            domains_block: block.domains,
          });
          const maxTokens = clamp(
            args.max_tokens ?? defaultMaxTokens,
            MIN_MAX_TOKENS,
            MAX_MAX_TOKENS,
          );
          const format = args.response_format ?? defaultFormat;
          const session = sessionFor(wv, args.session_id);
          const deadline = deadlineCap
            ? Math.min(args.deadline_ms ?? deadlineCap, deadlineCap)
            : args.deadline_ms;
          const [res, freshnessNote] = await Promise.all([
            wv.research(
              args.query,
              toResearchOptions(input, {
                signal: ctx.mcpReq.signal,
                maxOutputTokens: maxTokens,
                responseFormat: format,
                sessionId: session.id,
                deadlineMs: deadline,
                onProgress: progressNotifier(ctx),
                ...guard.searchLocation(),
              }),
            ),
            checkFreshness(wv, args.freshness),
          ]);
          const suggested = suggestedQueriesFor(res);
          const footer: string[] = [];
          if (freshnessNote) footer.push(freshnessNote);
          if (res.degraded === 'partial' && res.degradedReason)
            footer.push(`_Partial result: ${res.degradedReason}._`);
          if (session.minted)
            footer.push(`_session_id: ${session.id} — pass it back to reuse these pages._`);
          const rendered = renderResearch(res, {
            ...wv.renderOptions(),
            maxTokens,
            format,
            untrustedNotice: true,
            suggestedQueries: suggested,
            footerLine: footer.join('\n') || undefined,
          });
          let text = rendered.markdown;
          let hint: string | undefined;
          if (res.passages.length === 0) {
            hint = NO_PASSAGES_HINT;
            text = `${text}\n\n${hint}`;
          } else if (freshnessNote) hint = freshnessNote.replace(/^_|_$/g, '');
          return {
            content: [{ type: 'text', text }],
            ...structuredResearch(structured, res, {
              suggested_queries: suggested,
              omitted: rendered.omitted,
              session_id: session.minted ? session.id : undefined,
              hint: hint?.replace(/^_|_$/g, ''),
              retryable: res.passages.length === 0 ? true : undefined,
            }),
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
        // Claude Code: raise this tool's persist-to-disk threshold so paginated pages land in
        // context instead of a file (max_length ≤ 200k chars + link list). Harmless elsewhere.
        _meta: { 'anthropic/maxResultSizeChars': FETCH_MAX_RESULT_SIZE_CHARS },
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      async (args, ctx) => {
        try {
          guard.assertUrlAllowed(args.url);
          guard.consume();
          const wv = await wvp();
          if (args.query) {
            const res = await wv.fetchAndRetrieve(args.url, args.query, {
              topK: args.top_k,
              signal: ctx.mcpReq.signal,
            });
            const rendered = renderResearch(res, {
              ...wv.renderOptions(),
              maxTokens: defaultMaxTokens,
              format: args.response_format ?? defaultFormat,
            });
            const text =
              res.passages.length === 0
                ? `${rendered.markdown}\n\n_No passages of this page matched the query. Try a broader query, or call again without query to read the page._`
                : rendered.markdown;
            return {
              content: [{ type: 'text', text }],
              ...structuredResearch(structured, res, {
                omitted: rendered.omitted,
                ...(res.passages.length === 0
                  ? {
                      hint: 'Broaden the query or omit it to read the whole page.',
                      retryable: true,
                    }
                  : {}),
              }),
            };
          }
          const out = await runFetchTool(wv, args, {
            signal: ctx.mcpReq.signal,
            defaultMaxLength: opts.fetchMaxLength ?? DEFAULT_FETCH_MAX_LENGTH,
            fetchToolName: WEB_FETCH_TOOL_NAME,
          });
          return {
            content: [{ type: 'text', text: out.text }],
            ...(structured === 'off' ? {} : { structuredContent: out.structured }),
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
          const allow = validateDomains('domains_allow', args.domains_allow);
          if (!allow.ok) return argumentError('INVALID_ARGUMENT', allow.message, allow.hint);
          const block = validateDomains('domains_block', args.domains_block);
          if (!block.ok) return argumentError('INVALID_ARGUMENT', block.message, block.hint);
          guard.consume();
          const wv = await wvp();
          const input = guard.applyDomains({
            ...args,
            domains_allow: allow.domains,
            domains_block: block.domains,
          });
          const [results, freshnessNote] = await Promise.all([
            wv.search(args.query, {
              count: args.count,
              freshness: args.freshness,
              domainsAllow: input.domains_allow,
              domainsBlock: input.domains_block,
              signal: ctx.mcpReq.signal,
              ...guard.searchLocation(),
            }),
            checkFreshness(wv, args.freshness),
          ]);
          const lines = results.map(
            (r) => `${r.rank}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
          );
          const parts = [
            lines.join('\n') ||
              '_No results. Try fewer/other keywords, drop freshness or domain filters._',
          ];
          if (freshnessNote) parts.push(freshnessNote);
          if (results.length)
            parts.push(
              `→ To read a result: ${WEB_FETCH_TOOL_NAME}(url) — or ${WEB_FETCH_TOOL_NAME}(url, query) for only the relevant passages.`,
            );
          return {
            content: [{ type: 'text', text: parts.join('\n\n') }],
            ...(structured === 'off'
              ? {}
              : {
                  structuredContent: {
                    results,
                    ...(results.length === 0
                      ? {
                          hint: 'Try fewer/other keywords, drop freshness or domain filters.',
                          retryable: true,
                        }
                      : {}),
                  },
                }),
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  if (tools.has(WEBVECTOR_STATUS_TOOL_NAME)) {
    server.registerTool(
      WEBVECTOR_STATUS_TOOL_NAME,
      {
        title: 'WebVector status',
        description: WEBVECTOR_STATUS_DESCRIPTION,
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
          const [sessions, caps] = await Promise.all([wv.listSessions(), wv.capabilities()]);
          const status = {
            version: VERSION,
            tier: caps.tier,
            providers: caps,
            config: redactConfig(wv.config),
            server: {
              transport,
              sessionMode,
              structured,
              defaultResponseFormat: defaultFormat,
              maxTokens: defaultMaxTokens,
              uses: guard.uses,
              ...(guard.remaining !== undefined ? { remainingUses: guard.remaining } : {}),
              ...(guard.opts.allowedDomains?.length
                ? { allowedDomains: guard.opts.allowedDomains }
                : {}),
              ...(guard.opts.blockedDomains?.length
                ? { blockedDomains: guard.opts.blockedDomains }
                : {}),
              ...(guard.opts.userLocation ? { userLocation: guard.opts.userLocation } : {}),
            },
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

  registerPrompts(server, tools);

  // Deterministic tools/list order: canonical tools first, then legacy aliases (prompt-cache friendly).
  for (const add of aliases) add();
  return server;
}

export interface StdioOptions extends CreateServerOptions {}

/** Serve over stdio (the `npx -y webvector-mcp` path). Returns the handle; call `.close()` to stop. */
export function serveWebVectorStdio(opts: StdioOptions = {}) {
  const resolved = resolveServerOptions(opts, 'stdio');
  return serveStdio(async () => createWebVectorMcpServer(await resolved));
}

/**
 * Resolve the shared WebVector once per process (config file + env, no model load) so the
 * instructions/tier are computed once and stay static across requests.
 */
export async function resolveServerOptions<T extends CreateServerOptions>(
  opts: T,
  transport: 'stdio' | 'http' = opts.transport ?? 'stdio',
): Promise<T> {
  const webvector = opts.webvector ?? (await getSharedWebVector(opts.config));
  const tier = opts.tier ?? resolveTier(webvector);
  const guard = opts.guard ?? new ToolGuard(opts.guardOptions ?? {});
  return { ...opts, webvector, tier, transport, guard };
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
  const resolved = await resolveServerOptions(opts, 'http');
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
