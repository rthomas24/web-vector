import { providerHttpError, WebVectorError } from '../errors.js';
import { retry, withTimeout } from './concurrency.js';

export interface JsonRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  retries?: number;
  provider: string;
  /** Called with attempt number when retrying (for logging). */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * JSON request helper for provider APIs: timeout, retries on 429/5xx/network with backoff honouring
 * Retry-After, structured errors. Returns parsed JSON.
 */
export async function requestJson<T = any>(url: string, opts: JsonRequestOptions): Promise<T> {
  const { provider, retries = 2, timeoutMs = 30_000 } = opts;
  return retry(
    async () => {
      const signal = withTimeout(timeoutMs, opts.signal);
      let res: Response;
      try {
        res = await fetch(url, {
          method: opts.method ?? (opts.body ? 'POST' : 'GET'),
          headers: {
            accept: 'application/json',
            ...(opts.body ? { 'content-type': 'application/json' } : {}),
            ...opts.headers,
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal,
        });
      } catch (err) {
        throw WebVectorError.from(err, {
          code: 'PROVIDER_ERROR',
          provider,
          retryable: true,
          remediation: `Network error calling ${provider}. Check connectivity, proxy settings, and the endpoint URL.`,
        });
      }
      if (!res.ok) throw await providerHttpError(provider, res);
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new WebVectorError(`${provider} returned non-JSON response.`, {
          code: 'PROVIDER_ERROR',
          provider,
          details: { body: text.slice(0, 300) },
        });
      }
    },
    {
      retries,
      signal: opts.signal,
      shouldRetry: (err) => WebVectorError.is(err) && err.retryable,
      delayFor: (err) => (WebVectorError.is(err) ? err.retryAfterMs : undefined),
      onRetry: opts.onRetry,
    },
  );
}

/** Build a query string from an object, skipping undefined/null. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
