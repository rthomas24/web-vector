/**
 * Single-flight request coalescing + a short negative cache.
 *
 * Agent swarms and multi-query research calls routinely ask for the same page or the same search
 * at the same moment; instead of N identical requests (and N chances at a rate limit) concurrent
 * identical calls share one in-flight promise. URLs that just failed deterministically (robots
 * disallow, SSRF block, 4xx) are remembered for a few seconds so retries within a burst are free.
 */
import type { IngestOutcome } from '../ingest/index.js';
import type { Failure } from '../types.js';
import { currentUsage } from '../usage/meter.js';
import { LRU } from '../util/lru.js';

/** Promise coalescing keyed by string. */
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Coalesced joins since construction. */
  joined = 0;

  /** Run `fn` unless an identical call is already in flight — then share its result. */
  run<T>(key: string, fn: () => Promise<T>, onJoin?: () => void): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) {
      this.joined++;
      onJoin?.();
      return existing;
    }
    const p = fn().finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }
  get size(): number {
    return this.inflight.size;
  }
}

/** Failure codes worth remembering briefly (deterministic for the same URL over seconds). */
const NEGATIVE_CODES = new Set([
  'FETCH_BLOCKED_ROBOTS',
  'FETCH_BLOCKED_SSRF',
  'FETCH_HTTP_ERROR',
  'UNSUPPORTED_CONTENT_TYPE',
  'FETCH_TOO_LARGE',
]);

/** Should this failure be negatively cached? 4xx only for HTTP errors (never 408/425/429/5xx). */
export function isNegativeCacheable(f: Failure): boolean {
  if (!NEGATIVE_CODES.has(f.code)) return false;
  if (f.code === 'FETCH_HTTP_ERROR') {
    const m = /HTTP (\d{3})/.exec(f.message);
    const status = m ? Number(m[1]) : 0;
    return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
  }
  return true;
}

/**
 * Coordinates page ingestion for one WebVector instance: single-flight per canonical URL plus a
 * short negative cache. Counters are attributed to the ambient usage meter when present.
 */
export class FetchCoordinator {
  private readonly flight = new SingleFlight();
  private readonly negative: LRU<string, Failure>;
  private readonly negativeTtlMs: number;
  readonly counters = { coalesced: 0, negativeHits: 0 };

  constructor(opts: { negativeTtlMs?: number; maxNegative?: number } = {}) {
    this.negativeTtlMs = opts.negativeTtlMs ?? 15_000;
    this.negative = new LRU(opts.maxNegative ?? 2000, this.negativeTtlMs || undefined);
  }

  /** Bypassable per call (`cacheMode: 'bypass'` skips the negative cache, not the coalescing). */
  async ingest(
    key: string,
    fn: () => Promise<IngestOutcome>,
    opts: { bypassNegative?: boolean } = {},
  ): Promise<IngestOutcome> {
    if (this.negativeTtlMs && !opts.bypassNegative) {
      const neg = this.negative.get(key);
      if (neg) {
        this.counters.negativeHits++;
        const m = currentUsage();
        if (m) m.http.negativeHits++;
        return { url: neg.url ?? key, ok: false, failure: neg, ms: 0 };
      }
    }
    let joined = false;
    let outcome = await this.flight.run(key, fn, () => {
      joined = true;
      this.counters.coalesced++;
      const m = currentUsage();
      if (m) m.http.coalesced++;
    });
    if (joined) outcome = { ...outcome, coalesced: true };
    if (
      this.negativeTtlMs &&
      !outcome.ok &&
      outcome.failure &&
      isNegativeCacheable(outcome.failure)
    ) {
      this.negative.set(key, outcome.failure);
    }
    return outcome;
  }

  /** Coalesce arbitrary work (searches) by key. */
  share<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.flight.run(key, fn, () => {
      this.counters.coalesced++;
    });
  }

  forget(key: string): void {
    this.negative.delete(key);
  }
  clear(): void {
    this.negative.clear();
  }
}
