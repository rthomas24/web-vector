import { WebVectorError } from '../errors.js';
import type { Logger } from '../types.js';
import {
  createLimiter,
  KeyedQueue,
  type Limiter,
  retry,
  withTimeout,
} from '../util/concurrency.js';
import { RobotsCache } from './robots.js';
import { assertSafeUrl, createGuardedDispatcher, isGuardedLookupError } from './ssrf.js';

export interface FetcherOptions {
  userAgent: string;
  timeoutMs: number;
  maxRedirects: number;
  maxBytes: number;
  maxConcurrentFetches: number;
  perHostConcurrency: number;
  perHostMinIntervalMs: number;
  /** Cap for robots.txt Crawl-delay (ms); 0 = ignore Crawl-delay. */
  maxCrawlDelayMs?: number;
  respectRobotsTxt: boolean;
  retries: number;
  allowPrivateNetworks: boolean;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Additional request headers. */
  headers?: Record<string, string>;
  /** Custom DNS resolver (tests). */
  resolve?: (hostname: string) => Promise<string[]>;
}

export interface FetchedResource {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  charset?: string;
  bytes: Uint8Array;
  ms: number;
  redirects: number;
  headers: Headers;
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Polite, safe HTTP fetcher built on global fetch:
 * manual redirects (cap + SSRF re-check per hop), a connect-time DNS guard (no rebinding race),
 * timeouts, size cap via streaming, retries with backoff honouring Retry-After, per-host
 * concurrency + min interval, robots.txt.
 */
export class Fetcher {
  private readonly limiter: Limiter;
  private readonly hostQueue: KeyedQueue;
  private readonly robots?: RobotsCache;
  private readonly fetchImpl: typeof fetch;
  /** undici Agent whose DNS lookup refuses non-public addresses (undefined when a custom fetch is injected). */
  private dispatcher?: Promise<unknown | undefined>;
  constructor(private readonly opts: FetcherOptions) {
    this.limiter = createLimiter(opts.maxConcurrentFetches);
    this.hostQueue = new KeyedQueue({
      concurrency: opts.perHostConcurrency,
      minIntervalMs: opts.perHostMinIntervalMs,
    });
    this.fetchImpl = opts.fetch ?? fetch;
    if (!opts.fetch && !opts.allowPrivateNetworks) {
      this.dispatcher = createGuardedDispatcher({
        resolve: opts.resolve,
        connectTimeoutMs: Math.min(opts.timeoutMs, 10_000),
      });
    }
    if (opts.respectRobotsTxt) {
      this.robots = new RobotsCache({
        userAgent: opts.userAgent,
        // robots.txt goes through the same guarded, size-capped path as pages.
        fetch: (url, init) => this.guardedFetch(String(url), init),
        logger: opts.logger,
      });
    }
  }

  /** Raw fetch with the connect-time SSRF dispatcher attached (no redirects, no retries). */
  async guardedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const dispatcher = await this.dispatcher;
    return this.fetchImpl(url, { ...init, ...(dispatcher ? ({ dispatcher } as RequestInit) : {}) });
  }

  /**
   * Fetch a URL honouring all guards. Throws WebVectorError with a per-URL failure code.
   * `init.headers` adds per-request headers (conditional revalidation: If-None-Match /
   * If-Modified-Since); a 304 is then returned as a resource with `status: 304` and empty bytes.
   */
  async fetch(
    url: string,
    signal?: AbortSignal,
    init?: { headers?: Record<string, string> },
  ): Promise<FetchedResource> {
    const parsed = new URL(url);
    await assertSafeUrl(parsed, {
      allowPrivateNetworks: this.opts.allowPrivateNetworks,
      resolve: this.opts.resolve,
    });
    if (this.robots) {
      const { allowed, crawlDelayMs } = await this.robots.check(url, signal);
      const cap = this.opts.maxCrawlDelayMs ?? 10_000;
      const delay = crawlDelayMs === undefined ? 0 : Math.min(crawlDelayMs, cap);
      if (delay > 0) this.hostQueue.setMinInterval(parsed.hostname.toLowerCase(), delay);
      if (!allowed) {
        throw new WebVectorError(`robots.txt disallows fetching ${url}`, {
          code: 'FETCH_BLOCKED_ROBOTS',
          stage: 'ingest',
          remediation:
            'The site forbids crawlers for this path. Set `ingestion.respectRobotsTxt: false` only if you have permission.',
        });
      }
    }
    // Politeness is per hostname (a Crawl-delay on evil.github.io must not slow all of github.io).
    const host = parsed.hostname.toLowerCase();
    return this.limiter(() =>
      this.hostQueue.run(host, () =>
        retry((attempt) => this.doFetch(url, signal, attempt, init?.headers), {
          retries: this.opts.retries,
          signal,
          minDelayMs: 500,
          shouldRetry: (err) => WebVectorError.is(err) && err.retryable,
          delayFor: (err) => (WebVectorError.is(err) ? err.retryAfterMs : undefined),
          onRetry: (err, attempt, delay) =>
            this.opts.logger?.debug(
              `fetch: retry ${attempt} for ${url} in ${Math.round(delay)}ms (${err instanceof Error ? err.message : err})`,
            ),
        }),
      ),
    );
  }

  private async doFetch(
    startUrl: string,
    signal: AbortSignal | undefined,
    attempt: number,
    extraHeaders?: Record<string, string>,
  ): Promise<FetchedResource> {
    const t0 = Date.now();
    let current = startUrl;
    let redirects = 0;
    const timeoutSignal = withTimeout(this.opts.timeoutMs, signal);
    const startOrigin = new URL(startUrl).origin;
    for (;;) {
      let res: Response;
      try {
        // Caller-supplied headers (may include credentials) are only sent to the original origin.
        const sameOrigin = new URL(current).origin === startOrigin;
        res = await this.guardedFetch(current, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'user-agent': this.opts.userAgent,
            accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8,text/markdown;q=0.8,*/*;q=0.5',
            'accept-language': 'en-US,en;q=0.9,*;q=0.5',
            'accept-encoding': 'gzip, deflate, br',
            ...(sameOrigin ? this.opts.headers : stripCredentialHeaders(this.opts.headers)),
            ...extraHeaders,
          },
          signal: timeoutSignal,
        });
      } catch (err) {
        const e = err as Error;
        if (isGuardedLookupError(e)) {
          throw new WebVectorError(
            `Blocked fetch of ${current}: resolves to a non-public address.`,
            {
              code: 'FETCH_BLOCKED_SSRF',
              stage: 'ingest',
              remediation:
                'Private/loopback/link-local targets are blocked by default (SSRF protection).',
            },
          );
        }
        if (e?.name === 'TimeoutError' || (timeoutSignal.aborted && !signal?.aborted)) {
          throw new WebVectorError(`Timed out after ${this.opts.timeoutMs}ms fetching ${current}`, {
            code: 'FETCH_TIMEOUT',
            stage: 'ingest',
            retryable: attempt < 1,
          });
        }
        if (e?.name === 'AbortError')
          throw new WebVectorError('Fetch aborted', { code: 'ABORTED', stage: 'ingest', cause: e });
        throw new WebVectorError(`Network error fetching ${current}: ${causeMessage(e)}`, {
          code: 'FETCH_FAILED',
          stage: 'ingest',
          retryable: true,
          cause: e,
        });
      }

      if (res.status === 304 && extraHeaders) {
        // Conditional request: the cached copy is still valid; caller reuses it.
        await drain(res);
        return {
          url: startUrl,
          finalUrl: current,
          status: 304,
          contentType: '',
          bytes: new Uint8Array(),
          ms: Date.now() - t0,
          redirects,
          headers: res.headers,
        };
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await drain(res);
        if (!loc)
          throw new WebVectorError(`Redirect without Location from ${current}`, {
            code: 'FETCH_HTTP_ERROR',
            stage: 'ingest',
          });
        redirects++;
        if (redirects > this.opts.maxRedirects) {
          throw new WebVectorError(
            `Too many redirects (> ${this.opts.maxRedirects}) starting at ${startUrl}`,
            { code: 'TOO_MANY_REDIRECTS', stage: 'ingest' },
          );
        }
        const next = new URL(loc, current);
        next.hash = '';
        await assertSafeUrl(next, {
          allowPrivateNetworks: this.opts.allowPrivateNetworks,
          resolve: this.opts.resolve,
        });
        current = next.toString();
        continue;
      }

      if (!res.ok) {
        const retryAfter = res.headers.get('retry-after');
        await drain(res);
        const retryable = RETRY_STATUS.has(res.status);
        throw new WebVectorError(`HTTP ${res.status} fetching ${current}`, {
          code: res.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'FETCH_HTTP_ERROR',
          stage: 'ingest',
          retryable,
          retryAfterMs: retryAfter ? parseRetryAfterMs(retryAfter) : undefined,
          details: { status: res.status },
        });
      }

      const ctHeader = res.headers.get('content-type') ?? '';
      const { type: contentType, charset } = parseContentType(ctHeader);
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > this.opts.maxBytes) {
        await drain(res);
        throw tooLarge(current, len, this.opts.maxBytes);
      }
      const bytes = await readCapped(res, this.opts.maxBytes, current);
      return {
        url: startUrl,
        finalUrl: current,
        status: res.status,
        contentType,
        charset,
        bytes,
        ms: Date.now() - t0,
        redirects,
        headers: res.headers,
      };
    }
  }
}

function stripCredentialHeaders(
  h: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!h) return h;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h))
    if (!/^(authorization|cookie|proxy-authorization)$/i.test(k)) out[k] = v;
  return out;
}

function tooLarge(url: string, size: number, max: number): WebVectorError {
  return new WebVectorError(`Response too large (${size} > ${max} bytes) for ${url}`, {
    code: 'FETCH_TOO_LARGE',
    stage: 'ingest',
    remediation: 'Increase `ingestion.maxBytes` if you need larger documents.',
  });
}

export async function readCapped(res: Response, max: number, url: string): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => {});
      throw tooLarge(url, total, max);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Discard a response body without waiting: some interceptors/servers never settle cancel(). */
async function drain(res: Response): Promise<void> {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    /* ignore */
  }
}

export function parseContentType(header: string): { type: string; charset?: string } {
  const [type = '', ...params] = header.split(';');
  let charset: string | undefined;
  for (const p of params) {
    const [k, v] = p.split('=');
    if (k?.trim().toLowerCase() === 'charset' && v)
      charset = v.trim().replace(/^"|"$/g, '').toLowerCase();
  }
  return { type: type.trim().toLowerCase(), charset };
}

function parseRetryAfterMs(v: string): number | undefined {
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

function causeMessage(e: unknown): string {
  if (e instanceof Error) {
    const c = (e as Error & { cause?: unknown }).cause;
    if (c instanceof Error && c.message) return `${e.message} (${c.message})`;
    return e.message;
  }
  return String(e);
}
