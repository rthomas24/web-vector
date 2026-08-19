import type { CacheDb } from '../cache/db.js';
import { WebVectorError } from '../errors.js';
import type {
  EmbeddingLimits,
  EmbeddingProvider,
  EmbedKind,
  EmbedOptions,
  Logger,
} from '../types.js';
import { retry } from '../util/concurrency.js';
import { LRU } from '../util/lru.js';
import { l2Normalize, toFloat32 } from '../util/vector.js';

export interface BaseEmbeddingOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
  batchSize?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  options?: Record<string, unknown>;
}

/**
 * Base class for HTTP embedding providers: batching by provider limits, retries with backoff,
 * normalisation, order preservation. Subclasses implement `embedBatch`.
 */
export abstract class HttpEmbeddingProvider implements EmbeddingProvider {
  abstract readonly id: string;
  abstract readonly model: string;
  protected abstract embedBatch(
    texts: string[],
    kind: EmbedKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]>;
  abstract limits(): EmbeddingLimits;
  abstract dimensions(): number | Promise<number>;

  protected readonly fetchImpl: typeof fetch;
  protected readonly timeoutMs: number;
  constructor(protected readonly base: BaseEmbeddingOptions = {}) {
    this.fetchImpl = base.fetch ?? fetch;
    this.timeoutMs = base.timeoutMs ?? 60_000;
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const kind = opts.kind ?? 'document';
    const lim = this.limits();
    const batchSize = Math.max(
      1,
      Math.min(this.base.batchSize ?? lim.maxBatchSize, lim.maxBatchSize),
    );
    const maxChars = lim.maxInputChars ?? 32_000;
    const prepared = texts.map((t) => {
      const s = t.replace(/\s+/g, ' ').trim() || ' ';
      return s.length > maxChars ? s.slice(0, maxChars) : s;
    });
    const out: Float32Array[] = new Array(prepared.length);
    const batches: { start: number; items: string[] }[] = [];
    for (let i = 0; i < prepared.length; i += batchSize)
      batches.push({ start: i, items: prepared.slice(i, i + batchSize) });
    // token budget per batch (approx chars/4)
    const tokenBudget = lim.maxTokensPerBatch;
    const finalBatches: { start: number; items: string[] }[] = [];
    for (const b of batches) {
      if (!tokenBudget) {
        finalBatches.push(b);
        continue;
      }
      let cur: string[] = [];
      let curStart = b.start;
      let curTokens = 0;
      b.items.forEach((item, j) => {
        const t = Math.ceil(item.length / 3.5);
        if (cur.length && curTokens + t > tokenBudget) {
          finalBatches.push({ start: curStart, items: cur });
          cur = [];
          curStart = b.start + j;
          curTokens = 0;
        }
        cur.push(item);
        curTokens += t;
      });
      if (cur.length) finalBatches.push({ start: curStart, items: cur });
    }
    const concurrency = 4;
    let idx = 0;
    const worker = async () => {
      while (idx < finalBatches.length) {
        const b = finalBatches[idx++] as { start: number; items: string[] };
        const vecs = await retry(() => this.embedBatch(b.items, kind, opts.signal), {
          retries: 3,
          minDelayMs: 500,
          signal: opts.signal,
          shouldRetry: (err) => WebVectorError.is(err) && err.retryable,
          delayFor: (err) => (WebVectorError.is(err) ? err.retryAfterMs : undefined),
          onRetry: (err, attempt, delay) =>
            this.base.logger?.debug(
              `embed: retry ${attempt} (${this.id}) in ${Math.round(delay)}ms: ${err instanceof Error ? err.message : err}`,
            ),
        });
        if (vecs.length !== b.items.length) {
          throw new WebVectorError(
            `${this.id} returned ${vecs.length} embeddings for ${b.items.length} inputs.`,
            { code: 'EMBEDDING_FAILED', provider: this.id },
          );
        }
        vecs.forEach((v, j) => {
          out[b.start + j] = l2Normalize(toFloat32(v));
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, finalBatches.length) }, worker));
    return out;
  }
}

/** Wrap a plain function as an EmbeddingProvider. */
export function customEmbeddingProvider(
  id: string,
  model: string,
  fn: (texts: string[], kind: EmbedKind, signal?: AbortSignal) => Promise<ArrayLike<number>[]>,
  opts: { dimensions: number; limits?: Partial<EmbeddingLimits> },
): EmbeddingProvider {
  return {
    id,
    model,
    dimensions: () => opts.dimensions,
    limits: () => ({ maxBatchSize: 64, ...opts.limits }),
    async embed(texts, o = {}) {
      const vecs = await fn(texts, o.kind ?? 'document', o.signal);
      return vecs.map((v) => l2Normalize(toFloat32(v)));
    },
  };
}

export interface EmbeddingCacheOptions {
  /** In-memory entries (default 20 000). */
  max?: number;
  /** Persistent layer (the shared cache database); omit for memory only. */
  db?: CacheDb;
  /** Output dimensions of the embedder (MRL truncation changes vectors → part of the key). */
  dims?: number;
  /** Weight dtype for local models ('q8', 'fp32', …) — quantisation changes vectors too. */
  dtype?: string;
  /** Pending writes are flushed in one transaction at this size (default 256) or on flush(). */
  batchSize?: number;
}

/**
 * Embedding cache keyed by model + dimensions + dtype + role + content hash: an in-process LRU in
 * front of an optional persistent layer (`embeddings` table in pages.sqlite). Reads hydrate lazily
 * per lookup; writes are batched and written through in one transaction (`flush()`).
 */
export class EmbeddingCache {
  private readonly lru: LRU<string, Float32Array>;
  private db?: CacheDb;
  private dims: number;
  private dtype: string;
  private readonly batchSize: number;
  private pending: { model: string; role: string; hash: string; vec: Float32Array }[] = [];
  hits = 0;
  misses = 0;
  /** Hits served from the persistent layer (subset of `hits`). */
  diskHits = 0;
  constructor(maxOrOpts: number | EmbeddingCacheOptions = 20_000) {
    const o = typeof maxOrOpts === 'number' ? { max: maxOrOpts } : maxOrOpts;
    this.lru = new LRU(o.max ?? 20_000);
    this.db = o.db;
    this.dims = o.dims ?? 0;
    this.dtype = o.dtype ?? 'fp32';
    this.batchSize = o.batchSize ?? 256;
  }
  /** Attach/replace the persistent layer and key namespace (dims are known after embedder init). */
  configure(o: Pick<EmbeddingCacheOptions, 'db' | 'dims' | 'dtype'>): void {
    if (o.db !== undefined) this.db = o.db;
    if (o.dims !== undefined) this.dims = o.dims;
    if (o.dtype !== undefined) this.dtype = o.dtype;
  }
  get persistent(): boolean {
    return !!this.db && !this.db.readOnly;
  }
  key(model: string, hash: string, kind: EmbedKind): string {
    return `${model}\u0000${this.dims}\u0000${this.dtype}\u0000${kind}\u0000${hash}`;
  }
  get(model: string, hash: string, kind: EmbedKind): Float32Array | undefined {
    const k = this.key(model, hash, kind);
    let v = this.lru.get(k);
    if (!v && this.db) {
      try {
        v = this.db.getEmbedding(model, this.dims, this.dtype, kind, hash);
      } catch {
        v = undefined;
      }
      if (v) {
        this.diskHits++;
        this.lru.set(k, v);
      }
    }
    if (v) this.hits++;
    else this.misses++;
    return v;
  }
  set(model: string, hash: string, kind: EmbedKind, v: Float32Array): void {
    this.lru.set(this.key(model, hash, kind), v);
    if (this.persistent) {
      this.pending.push({ model, role: kind, hash, vec: v });
      if (this.pending.length >= this.batchSize) this.flush();
    }
  }
  /** Write pending entries to the persistent layer (one transaction). Never throws. */
  flush(): number {
    if (!this.pending.length) return 0;
    const rows = this.pending;
    this.pending = [];
    if (!this.persistent) return 0;
    try {
      this.db!.putEmbeddings(rows.map((r) => ({ ...r, dims: this.dims, dtype: this.dtype })));
      return rows.length;
    } catch {
      return 0;
    }
  }
  get size(): number {
    return this.lru.size;
  }
}
