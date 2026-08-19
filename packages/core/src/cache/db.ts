/**
 * One SQLite file (`pages.sqlite`) shared by the page cache and the persistent embedding cache.
 * Built on `node:sqlite` (Node ≥ 22.13 flag-free; feature-detected — callers fall back when it is
 * unavailable). WAL + busy_timeout make it safe for several WebVector processes (CLI + MCP server)
 * to share the same file.
 */
import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { defaultCacheDir, expandHome, importNodeSqlite } from '../runtime.js';

export const CACHE_DB_FILENAME = 'pages.sqlite';
export const CACHE_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pages (
  url_key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  last_access INTEGER NOT NULL,
  etag TEXT,
  last_modified TEXT,
  max_age_ms INTEGER,
  content_type TEXT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  md_bytes INTEGER NOT NULL,
  page_hash TEXT NOT NULL,
  meta TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_last_access ON pages(last_access);
CREATE INDEX IF NOT EXISTS pages_fetched_at ON pages(fetched_at);
CREATE TABLE IF NOT EXISTS embeddings (
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  dtype TEXT NOT NULL,
  role TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vec BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (model, dims, dtype, role, content_hash)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS embeddings_created_at ON embeddings(created_at);
`;

export interface CacheDbOptions {
  /** Directory holding pages.sqlite (created if missing). */
  dir: string;
  /** Milliseconds to wait on a locked database (default 5000). */
  busyTimeoutMs?: number;
  /** Open read-only (CLI inspection); fails if the file does not exist. */
  readOnly?: boolean;
}

export interface PageRow {
  url_key: string;
  url: string;
  final_url: string;
  fetched_at: number;
  last_access: number;
  etag: string | null;
  last_modified: string | null;
  max_age_ms: number | null;
  content_type: string;
  title: string;
  markdown: string;
  bytes: number;
  /** UTF-8 length of `markdown` (size accounting without scanning text). */
  md_bytes: number;
  page_hash: string;
  meta: string;
}

export interface CacheStats {
  path: string;
  fileBytes: number;
  pages: {
    count: number;
    markdownBytes: number;
    oldestFetchedAt?: string;
    newestFetchedAt?: string;
  };
  embeddings: {
    count: number;
    vectorBytes: number;
    models: { model: string; dims: number; dtype: string; count: number }[];
  };
  hosts: { host: string; count: number }[];
}

/** Resolve `ingestion.cache.dir`: 'auto' → XDG cache dir; false → memory only; else the path. */
export function resolveCacheDir(
  dir: string | false | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (dir === false || dir === undefined) return undefined;
  if (dir === 'auto') return defaultCacheDir(env);
  return expandHome(dir);
}

/**
 * Open (or create) the cache database. Returns undefined when `node:sqlite` is unavailable or the
 * directory cannot be created/written — callers then use memory-only or the JSON layout.
 */
export async function openCacheDb(opts: CacheDbOptions): Promise<CacheDb | undefined> {
  const mod = await importNodeSqlite();
  if (!mod) return undefined;
  const path = join(opts.dir, CACHE_DB_FILENAME);
  try {
    if (!opts.readOnly) {
      mkdirSync(opts.dir, { recursive: true });
      accessSync(opts.dir, constants.W_OK);
    }
    const db = new mod.DatabaseSync(path, { readOnly: !!opts.readOnly });
    return new CacheDb(db, path, opts);
  } catch {
    return undefined;
  }
}

/** Thin, synchronous wrapper over the shared cache database. */
export class CacheDb {
  private readonly stmts = new Map<string, StatementSync>();
  private closed = false;
  constructor(
    readonly db: DatabaseSync,
    readonly path: string,
    private readonly opts: CacheDbOptions,
  ) {
    const busy = Math.max(0, opts.busyTimeoutMs ?? 5000);
    db.exec(`PRAGMA busy_timeout = ${busy}`);
    if (!opts.readOnly) {
      try {
        db.exec('PRAGMA journal_mode = WAL');
      } catch {
        /* read-only media / network FS: keep the default journal */
      }
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec(SCHEMA);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'schema_version',
        String(CACHE_SCHEMA_VERSION),
      );
    }
  }

  get readOnly(): boolean {
    return !!this.opts.readOnly;
  }
  get isOpen(): boolean {
    return !this.closed && this.db.isOpen;
  }

  /** Prepared statement cache. */
  stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Run `fn` inside a transaction (BEGIN IMMEDIATE so writers queue instead of failing). */
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  // ─── pages ──────────────────────────────────────────────────────────────

  getPage(urlKey: string): PageRow | undefined {
    return this.stmt('SELECT * FROM pages WHERE url_key = ?').get(urlKey) as PageRow | undefined;
  }

  touchPage(urlKey: string, now = Date.now()): void {
    if (this.readOnly) return;
    this.stmt('UPDATE pages SET last_access = ? WHERE url_key = ?').run(now, urlKey);
  }

  putPage(row: PageRow): void {
    this.stmt(
      `INSERT OR REPLACE INTO pages
       (url_key, url, final_url, fetched_at, last_access, etag, last_modified, max_age_ms,
        content_type, title, markdown, bytes, md_bytes, page_hash, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.url_key,
      row.url,
      row.final_url,
      row.fetched_at,
      row.last_access,
      row.etag,
      row.last_modified,
      row.max_age_ms,
      row.content_type,
      row.title,
      row.markdown,
      row.bytes,
      row.md_bytes,
      row.page_hash,
      row.meta,
    );
  }

  /** Re-stamp a page after a 304 (validators may have been refreshed). */
  restampPage(
    urlKey: string,
    fetchedAt: number,
    validators: { etag?: string | null; lastModified?: string | null; maxAgeMs?: number | null },
  ): void {
    this.stmt(
      'UPDATE pages SET fetched_at = ?, last_access = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), max_age_ms = COALESCE(?, max_age_ms) WHERE url_key = ?',
    ).run(
      fetchedAt,
      fetchedAt,
      validators.etag ?? null,
      validators.lastModified ?? null,
      validators.maxAgeMs ?? null,
      urlKey,
    );
  }

  deletePage(urlKey: string): boolean {
    return Number(this.stmt('DELETE FROM pages WHERE url_key = ?').run(urlKey).changes) > 0;
  }

  /** Total markdown bytes + row count (size accounting for eviction). */
  pageTotals(): { count: number; markdownBytes: number } {
    const r = this.stmt(
      'SELECT count(*) AS count, COALESCE(sum(md_bytes), 0) AS bytes FROM pages',
    ).get() as { count: number; bytes: number };
    return { count: r.count, markdownBytes: r.bytes };
  }

  /**
   * LRU eviction in one statement: keep the `maxPages` most recently accessed rows and stay under
   * `maxBytes` of markdown. Returns rows removed.
   */
  evictPages(maxPages: number, maxBytes: number): number {
    const t = this.pageTotals();
    if (t.count <= maxPages && t.markdownBytes <= maxBytes) return 0;
    // Rows ordered by recency; find how many newest rows fit both budgets.
    const rows = this.stmt(
      'SELECT url_key, md_bytes AS len FROM pages ORDER BY last_access DESC',
    ).all() as { url_key: string; len: number }[];
    let keep = 0;
    let bytes = 0;
    for (const r of rows) {
      if (keep >= maxPages || bytes + r.len > maxBytes) break;
      bytes += r.len;
      keep++;
    }
    const cutoffKey = rows[keep]?.url_key;
    if (!cutoffKey) return 0;
    const cutoff = this.stmt('SELECT last_access FROM pages WHERE url_key = ?').get(cutoffKey) as
      | { last_access: number }
      | undefined;
    if (!cutoff) return 0;
    // Everything at or older than the cutoff goes (ties resolved by deleting the older-or-equal set).
    return Number(
      this.stmt('DELETE FROM pages WHERE last_access <= ?').run(cutoff.last_access).changes,
    );
  }

  /** Delete pages fetched before `olderThanMs` ago (0 = everything). Returns rows removed. */
  prunePages(olderThanMs: number, now = Date.now()): number {
    return Number(
      this.stmt('DELETE FROM pages WHERE fetched_at < ?').run(now - olderThanMs).changes,
    );
  }

  listPages(limit = 100, offset = 0): Omit<PageRow, 'markdown' | 'meta'>[] {
    return this.stmt(
      'SELECT url_key, url, final_url, fetched_at, last_access, etag, last_modified, max_age_ms, content_type, title, bytes, md_bytes, page_hash FROM pages ORDER BY last_access DESC LIMIT ? OFFSET ?',
    ).all(limit, offset) as Omit<PageRow, 'markdown' | 'meta'>[];
  }

  clearPages(): number {
    return Number(this.stmt('DELETE FROM pages').run().changes);
  }

  // ─── embeddings ─────────────────────────────────────────────────────────

  getEmbedding(
    model: string,
    dims: number,
    dtype: string,
    role: string,
    hash: string,
  ): Float32Array | undefined {
    const row = this.stmt(
      'SELECT vec FROM embeddings WHERE model = ? AND dims = ? AND dtype = ? AND role = ? AND content_hash = ?',
    ).get(model, dims, dtype, role, hash) as { vec: Uint8Array } | undefined;
    if (!row) return undefined;
    return blobToF32(row.vec);
  }

  putEmbeddings(
    rows: {
      model: string;
      dims: number;
      dtype: string;
      role: string;
      hash: string;
      vec: Float32Array;
    }[],
    now = Date.now(),
  ): void {
    if (!rows.length || this.readOnly) return;
    const st = this.stmt(
      'INSERT OR REPLACE INTO embeddings(model, dims, dtype, role, content_hash, vec, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.transaction(() => {
      for (const r of rows) st.run(r.model, r.dims, r.dtype, r.role, r.hash, f32ToBlob(r.vec), now);
    });
  }

  pruneEmbeddings(olderThanMs: number, now = Date.now()): number {
    return Number(
      this.stmt('DELETE FROM embeddings WHERE created_at < ?').run(now - olderThanMs).changes,
    );
  }

  clearEmbeddings(): number {
    return Number(this.stmt('DELETE FROM embeddings').run().changes);
  }

  // ─── maintenance ────────────────────────────────────────────────────────

  stats(): CacheStats {
    const p = this.stmt(
      'SELECT count(*) AS count, COALESCE(sum(md_bytes),0) AS bytes, min(fetched_at) AS oldest, max(fetched_at) AS newest FROM pages',
    ).get() as { count: number; bytes: number; oldest: number | null; newest: number | null };
    const e = this.stmt(
      'SELECT count(*) AS count, COALESCE(sum(length(vec)),0) AS bytes FROM embeddings',
    ).get() as { count: number; bytes: number };
    const models = this.stmt(
      'SELECT model, dims, dtype, count(*) AS count FROM embeddings GROUP BY model, dims, dtype ORDER BY count DESC',
    ).all() as { model: string; dims: number; dtype: string; count: number }[];
    const hostRows = this.stmt('SELECT url FROM pages').all() as { url: string }[];
    const hostCounts = new Map<string, number>();
    for (const r of hostRows) {
      let host = '';
      try {
        host = new URL(r.url).hostname;
      } catch {
        host = '?';
      }
      hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
    }
    const hosts = [...hostCounts.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);
    let fileBytes = 0;
    try {
      fileBytes = statSync(this.path).size;
      try {
        fileBytes += statSync(`${this.path}-wal`).size;
      } catch {
        /* no WAL file */
      }
    } catch {
      /* ignore */
    }
    return {
      path: this.path,
      fileBytes,
      pages: {
        count: p.count,
        markdownBytes: p.bytes,
        oldestFetchedAt: p.oldest ? new Date(p.oldest).toISOString() : undefined,
        newestFetchedAt: p.newest ? new Date(p.newest).toISOString() : undefined,
      },
      embeddings: { count: e.count, vectorBytes: e.bytes, models },
      hosts,
    };
  }

  /** Reclaim file space after large deletes. */
  vacuum(): void {
    if (this.readOnly) return;
    this.db.exec('VACUUM');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Float32Array → BLOB (copies when the view does not cover its whole buffer). */
export function f32ToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** BLOB → Float32Array (copies to guarantee 4-byte alignment). */
export function blobToF32(b: Uint8Array): Float32Array {
  if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
