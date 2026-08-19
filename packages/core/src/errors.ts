import type { Stage } from './types.js';

export type ErrorCode =
  | 'MISSING_API_KEY'
  | 'MISSING_DEPENDENCY'
  | 'INVALID_CONFIG'
  | 'UNKNOWN_PROVIDER'
  | 'SEARCH_BLOCKED'
  | 'SEARCH_FAILED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_ERROR'
  | 'FETCH_TIMEOUT'
  | 'FETCH_FAILED'
  | 'FETCH_TOO_LARGE'
  | 'FETCH_BLOCKED_ROBOTS'
  | 'FETCH_BLOCKED_SSRF'
  /** Anti-bot challenge / access-denied wall (Cloudflare, Akamai, DataDome, PerimeterX, Imperva…); `details.vendor`. Never retried. */
  | 'FETCH_BLOCKED_BOT'
  /** HTTP 402 pay-per-crawl (`details.vendor`, `details.price`). WebVector never pays. Never retried. */
  | 'FETCH_PAYMENT_REQUIRED'
  /** robots.txt `Content-Signal:` or `content-signal` header says `ai-input=no` and `ingestion.contentSignals` is `respect`. */
  | 'FETCH_BLOCKED_CONTENT_SIGNAL'
  | 'FETCH_HTTP_ERROR'
  | 'TOO_MANY_REDIRECTS'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'PARSE_EMPTY'
  | 'PARSE_FAILED'
  | 'ALL_FETCHES_FAILED'
  | 'CACHE_MISS'
  | 'EMBEDDING_FAILED'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'STORE_ERROR'
  | 'SESSION_NOT_FOUND'
  | 'ABORTED'
  | 'INTERNAL';

export interface WebVectorErrorOptions {
  code: ErrorCode;
  remediation?: string;
  retryable?: boolean;
  provider?: string;
  stage?: Stage;
  details?: unknown;
  cause?: unknown;
  /** Milliseconds to wait before retrying (from Retry-After) when known. */
  retryAfterMs?: number;
}

const SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{6,}|tvly-[A-Za-z0-9_-]{6,}|pa-[A-Za-z0-9_-]{6,}|jina_[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{20,}|BSA[A-Za-z0-9_-]{10,}|(?:Bearer|bearer)\s+[A-Za-z0-9._-]{8,})/g;
const URL_CREDS_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi;
const QUERY_KEY_RE = /([?&](?:api[_-]?key|key|token|apikey|access_token|secret)=)[^&\s]+/gi;

/** Redact obvious API keys/tokens, URL userinfo passwords and `?api_key=` query values in free text. */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_RE, (m) => `${m.slice(0, Math.min(4, m.length))}…${m.slice(-4)}`)
    .replace(URL_CREDS_RE, '$1***@')
    .replace(QUERY_KEY_RE, '$1***');
}

/** Deep-redact string leaves of an arbitrary value (used for error `details`). */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (depth > 6 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = redactDeep(v, depth + 1);
  return out as T;
}

export class WebVectorError extends Error {
  readonly code: ErrorCode;
  readonly remediation?: string;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly stage?: Stage;
  readonly details?: unknown;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: WebVectorErrorOptions) {
    super(redactSecrets(message), { cause: opts.cause });
    this.name = 'WebVectorError';
    this.code = opts.code;
    this.remediation = opts.remediation;
    this.retryable = opts.retryable ?? false;
    this.provider = opts.provider;
    this.stage = opts.stage;
    this.details = opts.details;
    this.retryAfterMs = opts.retryAfterMs;
  }

  /** Human-readable message including remediation. */
  describe(): string {
    return this.remediation ? `${this.message}\n→ ${this.remediation}` : this.message;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      retryable: this.retryable,
      provider: this.provider,
      stage: this.stage,
      retryAfterMs: this.retryAfterMs,
      details: redactDeep(this.details),
      cause:
        this.cause instanceof Error
          ? { name: this.cause.name, message: redactSecrets(this.cause.message) }
          : undefined,
    };
  }

  static is(err: unknown, code?: ErrorCode): err is WebVectorError {
    return err instanceof WebVectorError && (code === undefined || err.code === code);
  }

  /** Wrap unknown errors so callers always get a WebVectorError. */
  static from(err: unknown, fallback: WebVectorErrorOptions): WebVectorError {
    if (err instanceof WebVectorError) return err;
    if (err instanceof Error) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return new WebVectorError(err.message, {
          ...fallback,
          code: err.name === 'TimeoutError' ? 'FETCH_TIMEOUT' : 'ABORTED',
          cause: err,
        });
      }
      return new WebVectorError(err.message, { ...fallback, cause: err });
    }
    return new WebVectorError(String(err), fallback);
  }
}

// ─── Convenience constructors ────────────────────────────────────────────────

/**
 * Return `key` or throw MISSING_API_KEY with a remediation naming the env vars, the config path,
 * and (optionally) a keyless/offline alternative.
 */
export function requireApiKey(
  provider: string,
  key: string | undefined,
  envVars: string[],
  configPath: string,
  alternative?: string,
): string {
  if (key) return key;
  throw new WebVectorError(`${provider} requires an API key.`, {
    code: 'MISSING_API_KEY',
    provider,
    remediation: `Set ${envVars.join(' or ')} in your environment or pass \`${configPath}\` in config.${alternative ? ` ${alternative}` : ''}`,
  });
}

export function missingDependency(pkg: string, purpose: string, provider?: string): WebVectorError {
  return new WebVectorError(
    `Optional dependency "${pkg}" is not installed (needed for ${purpose}).`,
    {
      code: 'MISSING_DEPENDENCY',
      provider,
      remediation: `Run: npm i ${pkg}`,
    },
  );
}

/** Load an optional peer dependency lazily with a helpful error when missing. */
export async function importOptional<T = any>(
  pkg: string,
  purpose: string,
  provider?: string,
): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ pkg)) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(msg)) {
      throw missingDependency(pkg, purpose, provider);
    }
    throw err;
  }
}

/** Build a provider error from an HTTP response (reads body excerpt). */
export async function providerHttpError(
  provider: string,
  res: Response,
  stage?: Stage,
): Promise<WebVectorError> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 500);
  } catch {
    /* ignore */
  }
  const status = res.status;
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  if (status === 429) {
    return new WebVectorError(`${provider} rate-limited the request (429).`, {
      code: 'PROVIDER_RATE_LIMITED',
      provider,
      stage,
      retryable: true,
      retryAfterMs: retryAfter,
      remediation: retryAfter
        ? `Retry after ${Math.ceil(retryAfter / 1000)}s, lower concurrency, or upgrade your plan.`
        : 'Lower request rate/concurrency or upgrade your plan.',
      details: { status, body },
    });
  }
  if (status === 401 || status === 403) {
    return new WebVectorError(`${provider} rejected the credentials (${status}).`, {
      code: 'PROVIDER_AUTH',
      provider,
      stage,
      remediation:
        'Check that the API key is correct, active, and has access to this endpoint/plan.',
      details: { status, body },
    });
  }
  return new WebVectorError(`${provider} returned HTTP ${status}.`, {
    code: 'PROVIDER_ERROR',
    provider,
    stage,
    retryable: status >= 500 || status === 408,
    details: { status, body },
  });
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
