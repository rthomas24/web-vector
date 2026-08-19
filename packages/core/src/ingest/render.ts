/**
 * Pluggable page renderer (`ingestion.render`) — fired only when the served HTML is a
 * JavaScript shell (`PARSE_NEEDS_JS`) or, when configured, when the fetch was blocked. No headless
 * browser ships with WebVector: the built-in adapters call hosted rendering REST APIs, and
 * `instance` accepts any object with `render(url, { signal })`.
 *
 * Adapters (request/response shapes verified against the vendors' docs, Aug 2026):
 * - `cloudflare` — Cloudflare Browser Rendering `POST
 *   https://api.cloudflare.com/client/v4/accounts/{account_id}/browser-rendering/markdown`,
 *   `Authorization: Bearer <token>`, JSON body `{ url }` → `{ success, result: "<markdown>" }`
 *   (`/content` returns the rendered HTML in `result` the same way). Env: CLOUDFLARE_ACCOUNT_ID,
 *   CLOUDFLARE_API_TOKEN.
 * - `browserless` — `POST {baseUrl}/content?token=<token>` with JSON `{ url, gotoOptions }` →
 *   `text/html` body of the rendered page. Env: BROWSERLESS_TOKEN, BROWSERLESS_URL (default
 *   https://production-sfo.browserless.io).
 *
 * Remote renderers see the URL you send them (privacy note in docs). Every render is SSRF-checked
 * with the same guard as fetches and capped per run (`maxPerRun`).
 */
import { WebVectorError } from '../errors.js';
import { assertSafeUrl } from './ssrf.js';

export interface RenderResult {
  /** Rendered HTML (parsed with the HTML parser). */
  html?: string;
  /** Rendered markdown (used as-is via the text parser). */
  markdown?: string;
  /** Final URL after client-side redirects, when known. */
  finalUrl?: string;
}

export interface RenderProvider {
  readonly id: string;
  render(url: string, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<RenderResult>;
}

export type RenderWhen = 'needs-js' | 'blocked' | 'never';

export interface RenderConfig {
  provider: 'cloudflare' | 'browserless' | 'custom';
  when: RenderWhen;
  maxPerRun: number;
  timeoutMs: number;
  /** Cloudflare account id / Browserless base URL / any adapter-specific endpoint. */
  accountId?: string;
  baseUrl?: string;
  apiToken?: string;
  /** User function or provider instance (`provider: 'custom'`). */
  instance?: RenderProvider;
  fetch?: typeof fetch;
  userAgent?: string;
}

/** Per-run counter so a page full of shells cannot burn a rendering budget. */
export class RenderBudget {
  used = 0;
  constructor(readonly max: number) {}
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
}

/** Everything ingestUrl needs to decide and perform a render. */
export interface RenderHook {
  provider: RenderProvider;
  when: RenderWhen;
  budget: RenderBudget;
  timeoutMs: number;
  allowPrivateNetworks?: boolean;
  resolve?: (hostname: string) => Promise<string[]>;
}

/** Whether a failure code / HTTP status counts as "blocked" for `when: 'blocked'`. */
export function isBlockedFailure(code: string, status?: number): boolean {
  if (code === 'FETCH_BLOCKED_BOT' || code === 'FETCH_PAYMENT_REQUIRED') return true;
  if (code === 'PROVIDER_RATE_LIMITED') return true;
  if (code === 'FETCH_HTTP_ERROR' && status !== undefined)
    return status === 401 || status === 403 || status === 429 || status === 451 || status === 402;
  return false;
}

/** SSRF-guard + budget + timeout wrapper around a provider call. */
export async function renderWithHook(
  hook: RenderHook,
  url: string,
  signal?: AbortSignal,
): Promise<RenderResult> {
  const target = new URL(url);
  await assertSafeUrl(target, {
    allowPrivateNetworks: hook.allowPrivateNetworks,
    resolve: hook.resolve,
  });
  if (!hook.budget.take())
    throw new WebVectorError(
      `Render budget exhausted (${hook.budget.max} per run) — not rendering ${url}.`,
      { code: 'PARSE_NEEDS_JS', stage: 'ingest' },
    );
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), hook.timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await hook.provider.render(target.href, {
      signal: ctrl.signal,
      timeoutMs: hook.timeoutMs,
    });
    if (!r || (!r.html && !r.markdown))
      throw new WebVectorError(`Renderer ${hook.provider.id} returned no content for ${url}.`, {
        code: 'PARSE_EMPTY',
        stage: 'ingest',
      });
    return r;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ─── adapters ────────────────────────────────────────────────────────────────

export class CloudflareRenderProvider implements RenderProvider {
  readonly id = 'cloudflare';
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly opts: { accountId: string; apiToken: string; fetch?: typeof fetch },
  ) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }
  async render(url: string, o: { signal?: AbortSignal }): Promise<RenderResult> {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.opts.accountId)}/browser-rendering/markdown`;
    const res = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url }),
      signal: o.signal,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!res.ok || !json?.success) {
      const msg =
        json?.errors?.map((e: any) => e.message).join('; ') || text.slice(0, 200) || res.status;
      throw new WebVectorError(`Cloudflare Browser Rendering failed for ${url}: ${msg}`, {
        code: res.status === 401 || res.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
        provider: 'cloudflare',
        stage: 'ingest',
        retryable: res.status === 429 || res.status >= 500,
        details: { status: res.status },
      });
    }
    return { markdown: typeof json.result === 'string' ? json.result : '', finalUrl: url };
  }
}

export class BrowserlessRenderProvider implements RenderProvider {
  readonly id = 'browserless';
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly opts: {
      token: string;
      baseUrl?: string;
      fetch?: typeof fetch;
    },
  ) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }
  async render(url: string, o: { signal?: AbortSignal }): Promise<RenderResult> {
    const base = (this.opts.baseUrl ?? 'https://production-sfo.browserless.io').replace(/\/+$/, '');
    const endpoint = `${base}/content?token=${encodeURIComponent(this.opts.token)}`;
    const res = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil: 'networkidle2' },
        rejectResourceTypes: ['image', 'media', 'font'],
        bestAttempt: true,
      }),
      signal: o.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new WebVectorError(
        `Browserless /content failed for ${url}: HTTP ${res.status} ${body}`,
        {
          code: res.status === 401 || res.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
          provider: 'browserless',
          stage: 'ingest',
          retryable: res.status === 429 || res.status >= 500,
          details: { status: res.status },
        },
      );
    }
    return { html: await res.text(), finalUrl: url };
  }
}

/** Build the configured provider (undefined when `when: 'never'` or nothing is configured). */
export function createRenderProvider(
  cfg: Partial<RenderConfig> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RenderProvider | undefined {
  if (!cfg || cfg.when === 'never' || !cfg.when) return undefined;
  if (cfg.instance) return cfg.instance;
  const fetchImpl = cfg.fetch;
  switch (cfg.provider) {
    case 'cloudflare': {
      const accountId = cfg.accountId ?? env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = cfg.apiToken ?? env.CLOUDFLARE_API_TOKEN;
      if (!accountId || !apiToken)
        throw new WebVectorError('ingestion.render.provider "cloudflare" needs credentials.', {
          code: 'MISSING_API_KEY',
          provider: 'cloudflare',
          remediation:
            'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Browser Rendering permission) or pass ingestion.render.accountId / apiToken.',
        });
      return new CloudflareRenderProvider({ accountId, apiToken, fetch: fetchImpl });
    }
    case 'browserless': {
      const token = cfg.apiToken ?? env.BROWSERLESS_TOKEN;
      if (!token)
        throw new WebVectorError('ingestion.render.provider "browserless" needs a token.', {
          code: 'MISSING_API_KEY',
          provider: 'browserless',
          remediation:
            'Set BROWSERLESS_TOKEN (and BROWSERLESS_URL for self-hosted) or pass ingestion.render.apiToken / baseUrl.',
        });
      return new BrowserlessRenderProvider({
        token,
        baseUrl: cfg.baseUrl ?? env.BROWSERLESS_URL,
        fetch: fetchImpl,
      });
    }
    case 'custom':
      throw new WebVectorError('ingestion.render.provider "custom" needs an instance.', {
        code: 'INVALID_CONFIG',
        remediation:
          'Pass `ingestion.render.instance: { id, render(url, { signal }) => Promise<{ html?, markdown?, finalUrl? }> }` in code config.',
      });
    default:
      return undefined;
  }
}
