import { BM25Index, type BM25Options } from '../retrieval/bm25.js';
import { MemoryVectorStore } from '../stores/memory.js';
import type { VectorStore } from '../types.js';
import { LRU } from '../util/lru.js';
import { canonicalizeUrl } from '../util/url.js';
import { bm25FieldsFor } from './ingest-stage.js';

export interface Session {
  id: string;
  /** Vector store for this session (own MemoryVectorStore in memory mode; shared external store otherwise). */
  store: VectorStore;
  /** Lexical side-index over chunks ingested in this process for this session. */
  bm25: BM25Index;
  /** Chunk texts by id (needed to build passages from BM25-only hits and for MMR vectors). */
  chunks: Map<string, import('../types.js').Chunk>;
  /** Canonical URLs already ingested in this session. */
  urls: Set<string>;
  createdAt: number;
  lastUsed: number;
  calls: number;
  /** Set once chunks were loaded back from a persistent store (or there was nothing to load). */
  restored?: boolean;
}

export interface SessionRegistryOptions {
  ttlMs: number;
  maxSessions: number;
  /** Factory for the per-session store. Memory mode creates a fresh store per session; external modes share one. */
  storeFactory: (sessionId: string) => VectorStore;
  sharedStore: boolean;
  /** Options for each session's lexical index. */
  bm25?: BM25Options;
  /**
   * When true for a session id, evicting it from the registry keeps its rows in the shared store
   * (persistent mode: data must survive idle periods and restarts).
   */
  retainOnEvict?: (id: string) => boolean;
}

/** LRU+TTL registry of research sessions. */
export class SessionRegistry {
  private readonly lru: LRU<string, Session>;
  constructor(private readonly opts: SessionRegistryOptions) {
    this.lru = new LRU<string, Session>(opts.maxSessions, opts.ttlMs, (id, s) => {
      if (!opts.sharedStore) void s.store.clear().catch(() => {});
      else if (!opts.retainOnEvict?.(id)) void s.store.clear(id).catch(() => {});
    });
  }

  /**
   * Rebuild a session's in-memory side state (chunk map, canonical URL set, BM25 index) from a
   * persistent shared store after a restart. No-op for memory stores or already-restored sessions.
   */
  async restore(session: Session): Promise<number> {
    if (session.restored || !this.opts.sharedStore || !session.store.listChunks) {
      session.restored = true;
      return 0;
    }
    session.restored = true;
    const chunks = await session.store.listChunks(session.id);
    let n = 0;
    for (const ch of chunks) {
      if (session.chunks.has(ch.id)) continue;
      session.chunks.set(ch.id, ch);
      if (!session.bm25.has(ch.id)) session.bm25.add(ch.id, bm25FieldsFor(ch));
      session.urls.add(ch.metadata.canonicalUrl ?? canonicalizeUrl(ch.metadata.url));
      n++;
    }
    return n;
  }
  get(id: string): Session | undefined {
    return this.lru.get(id);
  }
  getOrCreate(id: string): Session {
    let s = this.lru.get(id);
    if (!s) {
      s = {
        id,
        store: this.opts.storeFactory(id),
        bm25: new BM25Index(this.opts.bm25),
        chunks: new Map(),
        urls: new Set(),
        createdAt: Date.now(),
        lastUsed: Date.now(),
        calls: 0,
      };
      this.lru.set(id, s);
    }
    s.lastUsed = Date.now();
    s.calls++;
    return s;
  }
  async delete(id: string): Promise<boolean> {
    return this.lru.delete(id);
  }
  list(): {
    id: string;
    chunks: number;
    urls: number;
    calls: number;
    createdAt: string;
    lastUsed: string;
  }[] {
    return this.lru.keys().map((id) => {
      const s = this.lru.get(id) as Session;
      return {
        id,
        chunks: s.chunks.size,
        urls: s.urls.size,
        calls: s.calls,
        createdAt: new Date(s.createdAt).toISOString(),
        lastUsed: new Date(s.lastUsed).toISOString(),
      };
    });
  }
  purge(): number {
    return this.lru.purge();
  }
  clear(): void {
    this.lru.clear();
  }
  get size(): number {
    return this.lru.size;
  }
}

/** Ephemeral session: never registered, discarded after the call. */
export function ephemeralSession(store?: VectorStore, bm25?: BM25Options): Session {
  return {
    id: `ephemeral-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    store: store ?? new MemoryVectorStore(),
    bm25: new BM25Index(bm25),
    chunks: new Map(),
    urls: new Set(),
    createdAt: Date.now(),
    lastUsed: Date.now(),
    calls: 1,
  };
}
