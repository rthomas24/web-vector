/**
 * Tiny, dependency-free concurrency primitives: a semaphore (`limit`), a per-key polite queue with
 * min-interval + concurrency, retry with exponential backoff, and abort/timeout helpers.
 */

export interface Limiter {
  <T>(fn: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly pending: number;
}

export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run) run();
  };
  const limiter = (<T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(
          (v) => {
            active--;
            resolve(v);
            next();
          },
          (e) => {
            active--;
            reject(e);
            next();
          },
        );
      };
      queue.push(run);
      next();
    })) as Limiter;
  Object.defineProperty(limiter, 'active', { get: () => active });
  Object.defineProperty(limiter, 'pending', { get: () => queue.length });
  return limiter;
}

export interface KeyedQueueOptions {
  concurrency: number;
  minIntervalMs: number;
  /** Evict idle per-key state after this many ms (default 5 min). */
  idleTtlMs?: number;
}

interface KeyState {
  active: number;
  lastStart: number;
  minIntervalMs: number;
  queue: (() => void)[];
  lastTouched: number;
}

/** Per-key (per-host) queue enforcing concurrency and a minimum start interval. */
export class KeyedQueue {
  private readonly keys = new Map<string, KeyState>();
  constructor(private readonly opts: KeyedQueueOptions) {}

  /** Raise the min interval for a key (e.g. robots Crawl-delay). */
  setMinInterval(key: string, ms: number): void {
    const s = this.state(key);
    s.minIntervalMs = Math.max(s.minIntervalMs, ms);
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const s = this.state(key);
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        s.active++;
        s.lastStart = Date.now();
        s.lastTouched = s.lastStart;
        fn().then(
          (v) => {
            s.active--;
            resolve(v);
            this.pump(key);
          },
          (e) => {
            s.active--;
            reject(e);
            this.pump(key);
          },
        );
      };
      s.queue.push(start);
      this.pump(key);
    });
  }

  private state(key: string): KeyState {
    let s = this.keys.get(key);
    if (!s) {
      s = {
        active: 0,
        lastStart: 0,
        minIntervalMs: this.opts.minIntervalMs,
        queue: [],
        lastTouched: Date.now(),
      };
      this.keys.set(key, s);
      this.evictIdle();
    }
    return s;
  }

  private pump(key: string): void {
    const s = this.keys.get(key);
    if (!s || s.queue.length === 0 || s.active >= this.opts.concurrency) return;
    const wait = s.lastStart + s.minIntervalMs - Date.now();
    if (wait > 0) {
      setTimeout(() => this.pump(key), wait);
      return;
    }
    const start = s.queue.shift();
    if (start) start();
    // If concurrency allows more, schedule respecting interval.
    if (s.queue.length && s.active < this.opts.concurrency)
      setTimeout(() => this.pump(key), s.minIntervalMs);
  }

  private evictIdle(): void {
    const ttl = this.opts.idleTtlMs ?? 5 * 60_000;
    if (this.keys.size < 256) return;
    const now = Date.now();
    for (const [k, s] of this.keys) {
      if (s.active === 0 && s.queue.length === 0 && now - s.lastTouched > ttl) this.keys.delete(k);
    }
  }
}

export interface RetryOptions {
  retries: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  signal?: AbortSignal;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Return a delay override in ms (e.g. from Retry-After). */
  delayFor?: (err: unknown) => number | undefined;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { retries, minDelayMs = 300, maxDelayMs = 10_000, factor = 2, jitter = true } = opts;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const can = attempt < retries && (opts.shouldRetry ? opts.shouldRetry(err, attempt) : true);
      if (!can) throw err;
      let delay = opts.delayFor?.(err) ?? Math.min(maxDelayMs, minDelayMs * factor ** attempt);
      if (jitter) delay = delay * (0.5 + Math.random());
      delay = Math.min(delay, maxDelayMs * 3);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay, opts.signal);
      attempt++;
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const e = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** Combine an optional caller signal with a timeout. */
export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** Run promises with a global deadline; whatever has not settled by then is treated as failed. */
export async function settleWithDeadline<T>(
  promises: Promise<T>[],
  deadlineMs: number,
  onTimeout: (index: number) => T,
  /** Called once when the deadline fires with work still pending (e.g. to abort it). */
  onDeadline?: () => void,
): Promise<T[]> {
  const results: T[] = new Array(promises.length);
  const done = new Set<number>();
  const settled = Promise.all(
    promises.map((p, i) =>
      p.then(
        (v) => {
          results[i] = v;
          done.add(i);
        },
        (e) => {
          results[i] = e as T;
          done.add(i);
        },
      ),
    ),
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  let timedOut = false;
  for (let i = 0; i < promises.length; i++)
    if (!done.has(i)) {
      results[i] = onTimeout(i);
      timedOut = true;
    }
  if (timedOut) onDeadline?.();
  return results;
}
