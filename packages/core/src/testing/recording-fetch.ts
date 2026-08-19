/**
 * Record / replay `fetch` for deterministic tests and evaluations.
 *
 * Wrap any fetch implementation and pass the result as `WebVectorConfig.fetch`:
 *
 * ```ts
 * const wv = await WebVector.create({ fetch: recordingFetch({ dir: 'eval/fixtures/http' }) });
 * ```
 *
 * Modes (from `mode` or the `WEBVECTOR_HTTP_FIXTURES` env var, default `replay`):
 * - `record`  — always hit the network and (re)write the fixture.
 * - `replay`  — serve fixtures only; a missing fixture throws (so CI never touches the network).
 * - `auto`    — replay when a fixture exists, otherwise record it (convenient while growing a set).
 * - `off`     — plain pass-through.
 *
 * One JSON file per request, keyed by `METHOD url` (+ a hash of the request body for non-GET).
 * Only a small allow-list of response headers is stored; `set-cookie` and anything credential-like
 * is never written. Bodies are stored as UTF-8 for text types and base64 otherwise.
 *
 * Note: this bypasses the fetcher's connect-time SSRF guard (that guard is only attached when no
 * custom fetch is injected). Use it for tests/evals, not in production.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sha256 } from '../util/hash.js';

export type RecordingMode = 'record' | 'replay' | 'auto' | 'off';

export interface RecordingFetchOptions {
  /** Directory holding fixture files (created on demand in record/auto mode). */
  dir: string;
  /** Overrides `WEBVECTOR_HTTP_FIXTURES`; default `replay`. */
  mode?: RecordingMode;
  /** Underlying fetch used in record/auto/off modes (default `globalThis.fetch`). */
  fetch?: typeof fetch;
  /** Response headers to persist (lower-case). Defaults cover content negotiation + caching. */
  keepHeaders?: string[];
  /** Custom fixture key; default `METHOD url` (+ body hash for non-GET). */
  key?: (url: string, init?: RequestInit) => string;
  /** Store text bodies gzip-compressed (base64) — ~5–8× smaller for HTML. Default false. */
  compress?: boolean;
  /**
   * Rewrite a text body before it is stored (e.g. drop `<script>`/`<style>` blocks to keep
   * fixtures small). Applied at record time only; replay serves what was stored.
   */
  transformBody?: (body: string, fixture: Omit<HttpFixture, 'body' | 'bodyEncoding'>) => string;
}

export interface HttpFixture {
  key: string;
  url: string;
  method: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64' | 'gzip-base64';
  recordedAt: string;
}

export interface RecordingFetchStats {
  mode: RecordingMode;
  hits: number;
  misses: number;
  recorded: number;
  passthrough: number;
}

export type RecordingFetch = typeof fetch & {
  stats: RecordingFetchStats;
  /** Fixture file path for a request (useful in tests). */
  fixturePath: (url: string, init?: RequestInit) => string;
};

const DEFAULT_KEEP_HEADERS = [
  'content-type',
  'content-length',
  'content-language',
  'content-encoding',
  'content-signal',
  'last-modified',
  'etag',
  'cache-control',
  'location',
  'retry-after',
  'vary',
  'x-markdown-tokens',
  'x-original-tokens',
  'cf-mitigated',
  'server',
];

/** Response statuses that must not carry a body (Fetch spec "null body status"). */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

const TEXT_TYPE_RE =
  /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml|x-www-form-urlencoded)|image\/svg\+xml)/i;

function resolveMode(explicit?: RecordingMode): RecordingMode {
  if (explicit) return explicit;
  const env = process.env.WEBVECTOR_HTTP_FIXTURES?.toLowerCase();
  if (env === 'record' || env === 'replay' || env === 'auto' || env === 'off') return env;
  return 'replay';
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function defaultKey(url: string, init?: RequestInit): string {
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body;
  const bodyHash = method !== 'GET' && typeof body === 'string' ? ` ${sha256(body, 12)}` : '';
  return `${method} ${url}${bodyHash}`;
}

/** Human-readable but collision-safe file name: `<host>__<path-slug>__<hash>.json`. */
function fileNameFor(key: string, url: string): string {
  let host = 'unknown';
  let slug = '';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/[^a-z0-9.-]/gi, '_');
    slug = (u.pathname + u.search)
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  } catch {
    /* keep defaults */
  }
  return `${host}__${slug || 'root'}__${sha256(key, 12)}.json`;
}

/**
 * Create a fetch that records to / replays from `opts.dir`.
 */
export function recordingFetch(opts: RecordingFetchOptions): RecordingFetch {
  const mode = resolveMode(opts.mode);
  const base = opts.fetch ?? globalThis.fetch;
  const keep = new Set((opts.keepHeaders ?? DEFAULT_KEEP_HEADERS).map((h) => h.toLowerCase()));
  const keyOf = opts.key ?? defaultKey;
  const stats: RecordingFetchStats = { mode, hits: 0, misses: 0, recorded: 0, passthrough: 0 };

  const fixturePath = (url: string, init?: RequestInit) =>
    join(opts.dir, fileNameFor(keyOf(url, init), url));

  const readFixture = (path: string): HttpFixture | undefined => {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as HttpFixture;
  };

  const toResponse = (fx: HttpFixture): Response => {
    const body = NULL_BODY_STATUS.has(fx.status)
      ? null
      : fx.bodyEncoding === 'base64'
        ? Buffer.from(fx.body, 'base64')
        : fx.bodyEncoding === 'gzip-base64'
          ? gunzipSync(Buffer.from(fx.body, 'base64')).toString('utf8')
          : fx.body;
    const headers = new Headers(fx.headers);
    // A stored content-length may not match a re-encoded body; let the runtime compute it.
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(body, { status: fx.status, statusText: fx.statusText, headers });
  };

  const record = async (
    key: string,
    url: string,
    method: string,
    path: string,
    res: Response,
  ): Promise<Response> => {
    const buf = Buffer.from(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (keep.has(k)) headers[k] = v;
    });
    const contentType = res.headers.get('content-type') ?? '';
    const isText = TEXT_TYPE_RE.test(contentType) || (contentType === '' && looksUtf8(buf));
    const meta = {
      key,
      url,
      method,
      status: res.status,
      statusText: res.statusText,
      headers,
      recordedAt: new Date().toISOString(),
    };
    let fx: HttpFixture;
    if (isText) {
      let text = buf.toString('utf8');
      if (opts.transformBody) text = opts.transformBody(text, meta);
      fx = opts.compress
        ? { ...meta, body: gzipSync(text).toString('base64'), bodyEncoding: 'gzip-base64' }
        : { ...meta, body: text, bodyEncoding: 'utf8' };
    } else {
      fx = { ...meta, body: buf.toString('base64'), bodyEncoding: 'base64' };
    }
    mkdirSync(opts.dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(fx, null, 2)}\n`);
    stats.recorded++;
    return toResponse(fx);
  };

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (mode === 'off') {
      stats.passthrough++;
      return base(input, init);
    }
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    const key = keyOf(url, { ...init, method });
    const path = join(opts.dir, fileNameFor(key, url));

    if (mode !== 'record') {
      const fx = readFixture(path);
      if (fx) {
        stats.hits++;
        if (init?.signal?.aborted)
          throw new DOMException('The operation was aborted.', 'AbortError');
        return toResponse(fx);
      }
      stats.misses++;
      if (mode === 'replay') {
        throw new Error(
          `recordingFetch: no fixture for "${key}" (expected ${path}). ` +
            'Run with WEBVECTOR_HTTP_FIXTURES=record (or auto) to create it.',
        );
      }
    }
    const res = await base(input, init);
    return record(key, url, method, path, res);
  };

  return Object.assign(impl as typeof fetch, { stats, fixturePath });
}

/** Cheap check that a buffer decodes as UTF-8 text (no replacement chars, no binary control bytes). */
function looksUtf8(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  const text = buf.subarray(0, 4096).toString('utf8');
  if (text.includes('\uFFFD')) return false;
  for (let i = 0; i < Math.min(text.length, 512); i++) {
    const cp = text.charCodeAt(i);
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return false;
  }
  return true;
}
