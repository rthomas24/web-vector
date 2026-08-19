/**
 * `sqlite` vector store — the zero-dependency persistent store (Node's built-in `node:sqlite`).
 *
 * Chunks live in one table with their Float32 vector as a BLOB; candidate rows are narrowed in SQL
 * (collection, session, URLs) and cosine similarity is computed in JS over the candidates. That is
 * fast enough for research sessions (≈ 1 ms per 1 000 384-d vectors, ~50 ms at 50k) — the ceiling
 * for the brute-force path is roughly 50 000 vectors per collection; beyond that use pgvector /
 * Qdrant / Chroma, or install the optional `sqlite-vec` extension (`store.options.vec: true`), which
 * ranks candidates inside SQLite with `vec_distance_cosine`.
 *
 * File: `store.url` (default `$XDG_DATA_HOME/webvector/store.sqlite`, i.e. ~/.local/share/webvector).
 * WAL + busy_timeout for multi-process use; session rows expire on disk after `store.sessionTtlMs`
 * (the `persistent` session is retained). The BM25 side-index is rebuilt from stored chunk text when
 * a session is restored (`SessionRegistry.restore`).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { blobToF32, f32ToBlob } from '../cache/db.js';
import { importOptional, WebVectorError } from '../errors.js';
import { defaultDataDir, expandHome, importNodeSqlite } from '../runtime.js';
import type {
  Chunk,
  ChunkMetadata,
  Logger,
  ScoredChunk,
  VectorStore,
  VectorStoreCapabilities,
  VectorStoreQueryOptions,
} from '../types.js';
import { l2Normalize } from '../util/vector.js';
import { buildFilter } from './memory.js';

export const SQLITE_STORE_FILENAME = 'store.sqlite';
/** Documented ceiling for the brute-force cosine path (per collection). */
export const SQLITE_STORE_BRUTE_FORCE_CEILING = 50_000;

export interface SqliteStoreOptions {
  /** File path (`~` expanded) or `:memory:`. Default: `$XDG_DATA_HOME/webvector/store.sqlite`. */
  url?: string;
  collection?: string;
  logger?: Logger;
  /** Expire session rows older than this on disk (0 = never). */
  sessionTtlMs?: number;
  options?: {
    /** Load the optional `sqlite-vec` extension and rank in SQL. */
    vec?: boolean;
    /** Session ids never expired by the TTL (default ['persistent']). */
    retainSessions?: string[];
    /** Milliseconds to wait on a locked database (default 5000). */
    busyTimeoutMs?: number;
  } & Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  collection TEXT PRIMARY KEY,
  dims INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  text TEXT NOT NULL,
  embed_text TEXT,
  metadata TEXT NOT NULL,
  vec BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS chunks_session ON chunks(collection, session_id);
CREATE INDEX IF NOT EXISTS chunks_updated ON chunks(collection, updated_at);
`;

interface ChunkRow {
  id: string;
  session_id: string | null;
  url: string;
  canonical_url: string;
  text: string;
  embed_text: string | null;
  metadata: string;
  vec?: Uint8Array;
}

function rowToChunk(r: ChunkRow, withVector: boolean): Chunk {
  const metadata = JSON.parse(r.metadata) as ChunkMetadata;
  const c: Chunk = { id: r.id, text: r.text, metadata };
  if (r.embed_text) c.embedText = r.embed_text;
  if (withVector && r.vec) c.vector = blobToF32(r.vec);
  return c;
}

export class SqliteVectorStore implements VectorStore {
  readonly id = 'sqlite';
  readonly path: string;
  readonly collection: string;
  private db?: DatabaseSync;
  private opening?: Promise<void>;
  private dims = 0;
  private model = '';
  private vecLoaded = false;
  private readonly stmts = new Map<string, StatementSync>();
  private lastExpire = 0;
  private readonly retain: Set<string>;

  constructor(private readonly opts: SqliteStoreOptions = {}) {
    const url = opts.url?.trim();
    this.path = !url ? join(defaultDataDir(), SQLITE_STORE_FILENAME) : expandHome(url);
    this.collection = opts.collection ?? 'webvector';
    this.retain = new Set(opts.options?.retainSessions ?? ['persistent']);
  }

  capabilities(): VectorStoreCapabilities {
    return { persistent: true, supportsFilter: true, supportsHas: true };
  }

  /** True when the sqlite-vec extension is loaded (SQL-side ranking). */
  get accelerated(): boolean {
    return this.vecLoaded;
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────

  private async open(): Promise<void> {
    if (this.db) return;
    if (!this.opening) {
      this.opening = (async () => {
        const mod = await importNodeSqlite();
        if (!mod) {
          throw new WebVectorError(
            'store.provider "sqlite" needs node:sqlite (Node ≥ 22.13), which this runtime does not provide.',
            {
              code: 'MISSING_DEPENDENCY',
              provider: 'sqlite',
              remediation:
                'Upgrade Node (≥ 22.13) or use store.provider: memory | pgvector | qdrant | chroma.',
            },
          );
        }
        if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
        const wantVec = !!this.opts.options?.vec;
        const db = new mod.DatabaseSync(this.path, wantVec ? { allowExtension: true } : {});
        db.exec(`PRAGMA busy_timeout = ${Math.max(0, this.opts.options?.busyTimeoutMs ?? 5000)}`);
        if (this.path !== ':memory:') {
          try {
            db.exec('PRAGMA journal_mode = WAL');
          } catch {
            /* keep default journal */
          }
        }
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec(SCHEMA);
        if (wantVec) {
          try {
            const vec = await importOptional<{ load: (db: unknown) => void }>(
              'sqlite-vec',
              'SQL-side vector ranking',
              'sqlite',
            );
            vec.load(db);
            db.prepare('SELECT vec_version() AS v').get();
            this.vecLoaded = true;
            this.opts.logger?.debug('sqlite store: sqlite-vec loaded (SQL-side cosine ranking)');
          } catch (err) {
            this.opts.logger?.warn(
              `sqlite store: sqlite-vec requested but unavailable (${err instanceof Error ? err.message : err}); using JS cosine.`,
            );
          } finally {
            try {
              db.enableLoadExtension(false);
            } catch {
              /* ignore */
            }
          }
        }
        this.db = db;
      })().catch((err) => {
        this.opening = undefined;
        throw err;
      });
    }
    return this.opening;
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.dbOrThrow().prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }
  private dbOrThrow(): DatabaseSync {
    if (!this.db)
      throw new WebVectorError('sqlite store used before init()', {
        code: 'STORE_ERROR',
        provider: 'sqlite',
      });
    return this.db;
  }
  private tx<T>(fn: () => T): T {
    const db = this.dbOrThrow();
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  async init(dimensions: number, embeddingModel: string): Promise<void> {
    await this.open();
    const row = this.stmt('SELECT dims, model FROM collections WHERE collection = ?').get(
      this.collection,
    ) as { dims: number; model: string } | undefined;
    if (row) {
      if (Number(row.dims) !== dimensions) {
        throw new WebVectorError(
          `sqlite collection "${this.collection}" holds ${row.dims}-dim vectors (${row.model}) but the current embedding model produces ${dimensions} (${embeddingModel}).`,
          {
            code: 'EMBEDDING_DIMENSION_MISMATCH',
            provider: 'sqlite',
            remediation:
              'Call store.clear() to reset the collection, or use a new `store.collection` name for the new model.',
          },
        );
      }
    } else {
      this.stmt(
        'INSERT INTO collections(collection, dims, model, created_at) VALUES (?, ?, ?, ?)',
      ).run(this.collection, dimensions, embeddingModel, Date.now());
    }
    this.dims = dimensions;
    this.model = embeddingModel;
    this.expireSessions();
  }

  async close(): Promise<void> {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    this.db = undefined;
    this.opening = undefined;
    this.stmts.clear();
  }

  // ─── maintenance ────────────────────────────────────────────────────────

  /** Delete session rows older than `sessionTtlMs` (retained sessions excluded). */
  expireSessions(now = Date.now()): number {
    const ttl = this.opts.sessionTtlMs ?? 0;
    if (!ttl || !this.db) return 0;
    this.lastExpire = now;
    const retain = [...this.retain];
    const sql = `DELETE FROM chunks WHERE collection = ? AND session_id IS NOT NULL AND updated_at < ?${
      retain.length ? ` AND session_id NOT IN (${retain.map(() => '?').join(',')})` : ''
    }`;
    const n = Number(this.stmt(sql).run(this.collection, now - ttl, ...retain).changes);
    if (n) this.opts.logger?.debug(`sqlite store: expired ${n} chunk(s) from stale sessions`);
    return n;
  }

  /** Session ids present on disk with their chunk counts and last update. */
  listSessions(): { id: string; chunks: number; lastUpdated: string }[] {
    if (!this.db) return [];
    return (
      this.stmt(
        'SELECT session_id AS id, count(*) AS chunks, max(updated_at) AS last FROM chunks WHERE collection = ? AND session_id IS NOT NULL GROUP BY session_id ORDER BY last DESC',
      ).all(this.collection) as { id: string; chunks: number; last: number }[]
    ).map((r) => ({
      id: r.id,
      chunks: Number(r.chunks),
      lastUpdated: new Date(r.last).toISOString(),
    }));
  }

  // ─── VectorStore ────────────────────────────────────────────────────────

  size(): number {
    if (!this.db) return 0;
    const r = this.stmt('SELECT count(*) AS n FROM chunks WHERE collection = ?').get(
      this.collection,
    ) as { n: number };
    return Number(r.n);
  }

  async has(ids: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!this.db || !ids.length) return out;
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const rows = this.stmt(
        `SELECT id FROM chunks WHERE collection = ? AND id IN (${batch.map(() => '?').join(',')})`,
      ).all(this.collection, ...batch) as { id: string }[];
      for (const r of rows) out.add(r.id);
    }
    return out;
  }

  /** One chunk with its vector (used for MMR / passage building). */
  get(id: string): Chunk | undefined {
    if (!this.db) return undefined;
    const row = this.stmt(
      'SELECT id, session_id, url, canonical_url, text, embed_text, metadata, vec FROM chunks WHERE collection = ? AND id = ?',
    ).get(this.collection, id) as ChunkRow | undefined;
    return row ? rowToChunk(row, true) : undefined;
  }

  /** Chunks of a session (or the whole collection) without vectors — session restore / BM25 rebuild. */
  async listChunks(sessionId?: string): Promise<Chunk[]> {
    await this.open();
    const rows = (sessionId
      ? this.stmt(
          'SELECT id, session_id, url, canonical_url, text, embed_text, metadata FROM chunks WHERE collection = ? AND session_id = ? ORDER BY updated_at',
        ).all(this.collection, sessionId)
      : this.stmt(
          'SELECT id, session_id, url, canonical_url, text, embed_text, metadata FROM chunks WHERE collection = ? ORDER BY updated_at',
        ).all(this.collection)) as unknown as ChunkRow[];
    return rows.map((r) => rowToChunk(r, false));
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    if (!chunks.length) return;
    await this.open();
    const now = Date.now();
    const st = this.stmt(
      `INSERT OR REPLACE INTO chunks
       (collection, id, session_id, url, canonical_url, text, embed_text, metadata, vec, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.tx(() => {
      for (const c of chunks) {
        if (!c.vector)
          throw new WebVectorError(`Chunk ${c.id} has no vector.`, {
            code: 'STORE_ERROR',
            provider: 'sqlite',
          });
        if (!this.dims) {
          this.dims = c.vector.length;
          this.stmt(
            'INSERT OR IGNORE INTO collections(collection, dims, model, created_at) VALUES (?, ?, ?, ?)',
          ).run(this.collection, this.dims, this.model || 'unknown', now);
        }
        if (c.vector.length !== this.dims) {
          throw new WebVectorError(
            `Vector dimension ${c.vector.length} != store dimension ${this.dims}.`,
            {
              code: 'EMBEDDING_DIMENSION_MISMATCH',
              provider: 'sqlite',
              remediation: 'Do not mix embedding models within one collection.',
            },
          );
        }
        const v = l2Normalize(c.vector);
        st.run(
          this.collection,
          c.id,
          c.metadata.sessionId ?? null,
          c.metadata.url,
          c.metadata.canonicalUrl,
          c.text,
          c.embedText ?? null,
          JSON.stringify(c.metadata),
          f32ToBlob(v),
          now,
        );
      }
    });
    if (this.opts.sessionTtlMs && now - this.lastExpire > 60_000) this.expireSessions(now);
  }

  async query(vector: Float32Array, opts: VectorStoreQueryOptions): Promise<ScoredChunk[]> {
    await this.open();
    if (this.dims && vector.length !== this.dims) {
      throw new WebVectorError(
        `Query vector dimension ${vector.length} != store dimension ${this.dims}.`,
        { code: 'EMBEDDING_DIMENSION_MISMATCH', provider: 'sqlite' },
      );
    }
    const q = l2Normalize(vector);
    const k = Math.max(1, opts.topK);
    const sid = opts.filter?.sessionId ?? opts.sessionId;
    const where: string[] = ['collection = ?'];
    const params: (string | number)[] = [this.collection];
    if (sid) {
      where.push('session_id = ?');
      params.push(sid);
    }
    const urls = opts.filter?.urls;
    if (urls?.length) {
      const ph = urls.map(() => '?').join(',');
      where.push(`(url IN (${ph}) OR canonical_url IN (${ph}))`);
      params.push(...urls, ...urls);
    }
    const jsFilter = opts.filter?.where ? buildFilter({ where: opts.filter.where }) : undefined;
    const cols = 'id, session_id, url, canonical_url, text, embed_text, metadata, vec';

    if (this.vecLoaded && !jsFilter) {
      const rows = this.stmt(
        `SELECT ${cols}, vec_distance_cosine(vec, ?) AS d FROM chunks WHERE ${where.join(' AND ')} ORDER BY d LIMIT ?`,
      ).all(f32ToBlob(q), ...params, k) as unknown as (ChunkRow & { d: number })[];
      return rows.map((r) => ({ ...rowToChunk(r, true), score: 1 - Number(r.d) }));
    }

    // Brute-force cosine in JS: stream candidate rows, keep a bounded min-heap of the best k.
    const it = this.stmt(`SELECT ${cols} FROM chunks WHERE ${where.join(' AND ')}`).iterate(
      ...params,
    ) as unknown as Iterable<ChunkRow>;
    const heapRow: ChunkRow[] = [];
    const heapScore: number[] = [];
    const swap = (i: number, j: number) => {
      [heapScore[i], heapScore[j]] = [heapScore[j] as number, heapScore[i] as number];
      [heapRow[i], heapRow[j]] = [heapRow[j] as ChunkRow, heapRow[i] as ChunkRow];
    };
    const up = (i: number) => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if ((heapScore[p] as number) <= (heapScore[i] as number)) break;
        swap(p, i);
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
        swap(m, i);
        i = m;
      }
    };
    const d = q.length;
    for (const row of it) {
      if (jsFilter && !jsFilter(rowToChunk(row, false))) continue;
      const v = blobToF32(row.vec as Uint8Array);
      let dotp = 0;
      for (let i = 0; i < d; i++) dotp += (q[i] as number) * (v[i] as number);
      if (heapScore.length < k) {
        heapRow.push(row);
        heapScore.push(dotp);
        up(heapScore.length - 1);
      } else if (dotp > (heapScore[0] as number)) {
        heapRow[0] = row;
        heapScore[0] = dotp;
        down();
      }
    }
    const out: ScoredChunk[] = heapRow.map((row, i) => ({
      ...rowToChunk(row, true),
      score: heapScore[i] as number,
    }));
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  async clear(sessionId?: string): Promise<void> {
    await this.open();
    if (sessionId) {
      this.stmt('DELETE FROM chunks WHERE collection = ? AND session_id = ?').run(
        this.collection,
        sessionId,
      );
      return;
    }
    this.tx(() => {
      this.stmt('DELETE FROM chunks WHERE collection = ?').run(this.collection);
      this.stmt('DELETE FROM collections WHERE collection = ?').run(this.collection);
    });
    this.dims = 0;
  }
}
