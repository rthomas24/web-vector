/**
 * Small TTL key/value cache for market data responses (feeds, JSON APIs, CSVs): an in-process
 * LRU in front of an optional SQLite table in the shared page-cache database
 * (`~/.cache/webvector/pages.sqlite`, table `markets_cache`). Entries keep the HTTP validators
 * so refreshes can be conditional, a stale copy is served when the origin fails, and known-
 * missing resources (404) can be remembered briefly so date-probing loops stay cheap.
 */
import type { CacheDb } from '../cache/db.js';
import { SingleFlight } from '../cache/single-flight.js';
import { LRU } from '../util/lru.js';

export interface CacheEntry<T = unknown> {
  value: T;
  fetchedAt: number;
  expiresAt: number;
  etag?: string;
  lastModified?: string;
}

interface Row {
  key: string;
  value: string;
  fetched_at: number;
  expires_at: number;
  etag: string | null;
  last_modified: string | null;
}

const TABLE = `CREATE TABLE IF NOT EXISTS markets_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  etag TEXT,
  last_modified TEXT
);
CREATE INDEX IF NOT EXISTS markets_cache_expires ON markets_cache(expires_at);`;

/** Expired rows older than this are deleted when the table is opened (stale-on-error window). */
const KEEP_EXPIRED_MS = 24 * 3_600_000;
const MISSING = 'missing:';
/** Bodies above this size (FINRA files, the SEC ticker map) stay on disk only; the LRU holds the small, hot entries. */
const MEM_MAX_CHARS = 256 * 1024;
const small = (e: CacheEntry) => typeof e.value !== 'string' || e.value.length <= MEM_MAX_CHARS;

export class MarketsCache {
  private readonly mem = new LRU<string, CacheEntry>(2000);
  private readonly flight = new SingleFlight();
  private opened?: Promise<CacheDb | undefined>;

  constructor(private readonly dbProvider?: () => Promise<CacheDb | undefined>) {}

  /** Open the table once per instance; prunes rows that are too old to serve even as stale copies. */
  private ensureDb(): Promise<CacheDb | undefined> {
    if (!this.opened) {
      this.opened = (async () => {
        try {
          const db = await this.dbProvider?.();
          if (!db?.isOpen || db.readOnly) return undefined;
          db.db.exec(TABLE);
          db.stmt('DELETE FROM markets_cache WHERE expires_at < ?').run(
            Date.now() - KEEP_EXPIRED_MS,
          );
          return db;
        } catch {
          return undefined;
        }
      })();
    }
    return this.opened;
  }

  /** Entry (fresh or stale) or undefined. Check `expiresAt` yourself for freshness. */
  async peek<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const m = this.mem.get(key) as CacheEntry<T> | undefined;
    if (m) return m;
    const db = await this.ensureDb();
    if (!db) return undefined;
    try {
      const row = db.stmt('SELECT * FROM markets_cache WHERE key = ?').get(key) as Row | undefined;
      if (!row) return undefined;
      const entry: CacheEntry<T> = {
        value: JSON.parse(row.value) as T,
        fetchedAt: row.fetched_at,
        expiresAt: row.expires_at,
        etag: row.etag ?? undefined,
        lastModified: row.last_modified ?? undefined,
      };
      if (small(entry)) this.mem.set(key, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    if (small(entry)) this.mem.set(key, entry);
    const db = await this.ensureDb();
    if (!db) return;
    try {
      db.stmt(
        'INSERT OR REPLACE INTO markets_cache(key, value, fetched_at, expires_at, etag, last_modified) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        key,
        JSON.stringify(entry.value),
        entry.fetchedAt,
        entry.expiresAt,
        entry.etag ?? null,
        entry.lastModified ?? null,
      );
    } catch {
      /* best effort */
    }
  }

  /** Extend an entry's freshness without rewriting its body (304 Not Modified). */
  private async touch(key: string, entry: CacheEntry, expiresAt: number): Promise<void> {
    if (small(entry)) this.mem.set(key, { ...entry, expiresAt });
    const db = await this.ensureDb();
    if (!db) return;
    try {
      db.stmt('UPDATE markets_cache SET expires_at = ? WHERE key = ?').run(expiresAt, key);
    } catch {
      /* best effort */
    }
  }

  /** Remember that a resource does not exist (404/410) for `ttlMs`. */
  markMissing(key: string, ttlMs: number, now = Date.now()): Promise<void> {
    return this.set(`${MISSING}${key}`, { value: 1, fetchedAt: now, expiresAt: now + ttlMs });
  }

  async isMissing(key: string, now = Date.now()): Promise<boolean> {
    const e = await this.peek(`${MISSING}${key}`);
    return !!e && e.expiresAt > now;
  }

  /**
   * Get-or-load with TTL, single-flight and stale-on-error: a fresh entry is returned as is; an
   * expired one is refreshed through `loader(prev)` (which may use `prev.etag`/`prev.lastModified`
   * for a conditional request and return `{ notModified: true }`); if the refresh throws and a
   * stale copy exists (younger than `KEEP_EXPIRED_MS`), the stale copy is returned with `stale: true`.
   */
  async remember<T>(
    key: string,
    ttlMs: number,
    loader: (
      prev?: CacheEntry<T>,
    ) => Promise<{ value: T; etag?: string; lastModified?: string } | { notModified: true }>,
    now = Date.now(),
  ): Promise<{ value: T; fromCache: boolean; stale: boolean; fetchedAt: number }> {
    const fresh = (e: CacheEntry<T>) => ({
      value: e.value,
      fromCache: true,
      stale: false,
      fetchedAt: e.fetchedAt,
    });
    const prev = await this.peek<T>(key);
    if (prev && prev.expiresAt > now) return fresh(prev);
    return this.flight.run(key, async () => {
      // Another caller may have refreshed while we waited for the flight lock.
      const again = await this.peek<T>(key);
      if (again && again.expiresAt > now) return fresh(again);
      try {
        const res = await loader(prev);
        if ('notModified' in res && prev) {
          await this.touch(key, prev, now + ttlMs);
          return fresh(prev);
        }
        const r = res as { value: T; etag?: string; lastModified?: string };
        await this.set(key, {
          value: r.value,
          fetchedAt: now,
          expiresAt: now + ttlMs,
          etag: r.etag,
          lastModified: r.lastModified,
        });
        return { value: r.value, fromCache: false, stale: false, fetchedAt: now };
      } catch (err) {
        if (prev && now - prev.fetchedAt <= KEEP_EXPIRED_MS)
          return { value: prev.value, fromCache: true, stale: true, fetchedAt: prev.fetchedAt };
        throw err;
      }
    });
  }
}
