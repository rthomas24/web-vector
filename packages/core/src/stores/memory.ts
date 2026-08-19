import { WebVectorError } from '../errors.js';
import type {
  Chunk,
  ChunkFilter,
  ScoredChunk,
  VectorStore,
  VectorStoreCapabilities,
  VectorStoreQueryOptions,
} from '../types.js';
import { l2Normalize } from '../util/vector.js';

/**
 * Brute-force cosine in-memory store over a flat Float32Array matrix (pre-normalised so cosine == dot).
 * ~1 ms/query for 2k×384 chunks; ~11 ms for 10k×1536. Supports sessionId scoping and metadata filters.
 */
export class MemoryVectorStore implements VectorStore {
  readonly id = 'memory';
  private dims = 0;
  private data = new Float32Array(0);
  private n = 0;
  private readonly chunks: Chunk[] = [];
  private readonly index = new Map<string, number>(); // id → row
  private embeddingModel?: string;

  constructor(private readonly opts: { initialCapacity?: number } = {}) {}

  capabilities(): VectorStoreCapabilities {
    return { persistent: false, supportsFilter: true, supportsHas: true };
  }

  async init(dimensions: number, embeddingModel: string): Promise<void> {
    if (this.dims && this.dims !== dimensions) {
      throw new WebVectorError(
        `Store holds ${this.dims}-dim vectors (${this.embeddingModel}) but the current embedding model produces ${dimensions} (${embeddingModel}).`,
        {
          code: 'EMBEDDING_DIMENSION_MISMATCH',
          remediation:
            'Call store.clear() or use a fresh store/session when switching embedding models.',
        },
      );
    }
    if (!this.dims) {
      this.dims = dimensions;
      this.data = new Float32Array(dimensions * (this.opts.initialCapacity ?? 1024));
    }
    this.embeddingModel = embeddingModel;
  }

  size(): number {
    return this.n;
  }

  async has(ids: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const id of ids) if (this.index.has(id)) out.add(id);
    return out;
  }

  get(id: string): Chunk | undefined {
    const row = this.index.get(id);
    return row === undefined ? undefined : this.chunks[row];
  }

  /** All chunks (optionally scoped) — used by the BM25 side index. */
  all(sessionId?: string): Chunk[] {
    return sessionId
      ? this.chunks.filter((c) => c.metadata.sessionId === sessionId)
      : [...this.chunks];
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    for (const c of chunks) {
      if (!c.vector)
        throw new WebVectorError(`Chunk ${c.id} has no vector.`, { code: 'STORE_ERROR' });
      if (!this.dims) await this.init(c.vector.length, 'unknown');
      if (c.vector.length !== this.dims) {
        throw new WebVectorError(
          `Vector dimension ${c.vector.length} != store dimension ${this.dims}.`,
          {
            code: 'EMBEDDING_DIMENSION_MISMATCH',
            remediation: 'Do not mix embedding models within one store.',
          },
        );
      }
      const v = l2Normalize(c.vector);
      const existing = this.index.get(c.id);
      if (existing !== undefined) {
        this.data.set(v, existing * this.dims);
        this.chunks[existing] = { ...c, vector: v };
        continue;
      }
      if ((this.n + 1) * this.dims > this.data.length) this.grow();
      this.data.set(v, this.n * this.dims);
      this.chunks.push({ ...c, vector: v });
      this.index.set(c.id, this.n);
      this.n++;
    }
  }

  private grow(): void {
    const next = new Float32Array(Math.max(this.dims * 1024, this.data.length * 2));
    next.set(this.data);
    this.data = next;
  }

  async query(vector: Float32Array, opts: VectorStoreQueryOptions): Promise<ScoredChunk[]> {
    if (this.n === 0 || this.dims === 0) return [];
    if (vector.length !== this.dims) {
      throw new WebVectorError(
        `Query vector dimension ${vector.length} != store dimension ${this.dims}.`,
        { code: 'EMBEDDING_DIMENSION_MISMATCH' },
      );
    }
    const q = l2Normalize(vector);
    const k = Math.max(1, opts.topK);
    const filter = buildFilter(opts.filter, opts.sessionId);
    const d = this.dims;
    // bounded min-heap of {row, score}
    const heapRow: number[] = [];
    const heapScore: number[] = [];
    const up = (i: number) => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if ((heapScore[p] as number) <= (heapScore[i] as number)) break;
        [heapScore[p], heapScore[i]] = [heapScore[i] as number, heapScore[p] as number];
        [heapRow[p], heapRow[i]] = [heapRow[i] as number, heapRow[p] as number];
        i = p;
      }
    };
    const down = () => {
      let i = 0;
      const len = heapScore.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < len && (heapScore[l] as number) < (heapScore[m] as number)) m = l;
        if (r < len && (heapScore[r] as number) < (heapScore[m] as number)) m = r;
        if (m === i) break;
        [heapScore[m], heapScore[i]] = [heapScore[i] as number, heapScore[m] as number];
        [heapRow[m], heapRow[i]] = [heapRow[i] as number, heapRow[m] as number];
        i = m;
      }
    };
    for (let row = 0; row < this.n; row++) {
      if (filter && !filter(this.chunks[row] as Chunk)) continue;
      const off = row * d;
      let dot = 0;
      for (let i = 0; i < d; i++) dot += (q[i] as number) * (this.data[off + i] as number);
      if (heapScore.length < k) {
        heapRow.push(row);
        heapScore.push(dot);
        up(heapScore.length - 1);
      } else if (dot > (heapScore[0] as number)) {
        heapRow[0] = row;
        heapScore[0] = dot;
        down();
      }
    }
    const out: ScoredChunk[] = heapRow.map((row, i) => ({
      ...(this.chunks[row] as Chunk),
      score: heapScore[i] as number,
    }));
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  async clear(sessionId?: string): Promise<void> {
    if (!sessionId) {
      this.n = 0;
      this.chunks.length = 0;
      this.index.clear();
      this.data = new Float32Array(this.dims * 1024);
      return;
    }
    // rebuild without the session
    const keep = this.chunks.filter((c) => c.metadata.sessionId !== sessionId);
    this.n = 0;
    this.chunks.length = 0;
    this.index.clear();
    this.data = new Float32Array(this.dims * Math.max(1024, keep.length + 64));
    await this.upsert(keep);
  }
}

export function buildFilter(
  filter: ChunkFilter | undefined,
  sessionId?: string,
): ((c: Chunk) => boolean) | undefined {
  const sid = filter?.sessionId ?? sessionId;
  const urls = filter?.urls ? new Set(filter.urls) : undefined;
  const where = filter?.where;
  if (!sid && !urls && !where) return undefined;
  return (c) => {
    if (sid && c.metadata.sessionId !== sid) return false;
    if (urls && !urls.has(c.metadata.url) && !urls.has(c.metadata.canonicalUrl)) return false;
    if (where) for (const [k, v] of Object.entries(where)) if (c.metadata[k] !== v) return false;
    return true;
  };
}
