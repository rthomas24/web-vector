import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customEmbeddingProvider } from '../src/embeddings/base.js';
import { WebVector } from '../src/pipeline/webvector.js';
import { probeRuntime } from '../src/runtime.js';
import { customSearchProvider } from '../src/search/providers.js';
import { createVectorStore, listVectorStores } from '../src/stores/index.js';
import { SqliteVectorStore } from '../src/stores/sqlite.js';
import { vectorStoreConformance } from '../src/testing/index.js';
import type { Chunk } from '../src/types.js';
import { sha256 } from '../src/util/hash.js';
import { silentLogger } from '../src/util/logger.js';

const caps = await probeRuntime();
const d = caps.sqlite ? describe : describe.skip;

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wv-store-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const vec = (seed: number, dims = 8) => {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = Math.sin(seed * (i + 1));
  return v;
};
const mk = (id: string, seed: number, sessionId?: string, text = `chunk ${id}`): Chunk => ({
  id,
  text,
  vector: vec(seed),
  metadata: {
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    title: id,
    chunkIndex: 0,
    totalChunks: 1,
    startOffset: 0,
    endOffset: 5,
    contentHash: sha256(id),
    pageHash: sha256(id),
    fetchedAt: new Date().toISOString(),
    searchRank: 1,
    searchQuery: 'q',
    contentType: 'text/plain',
    provider: 'test',
    sessionId,
    lang: 'en',
  },
});

d('SqliteVectorStore', () => {
  it('is registered as a store provider', () => {
    expect(listVectorStores()).toContain('sqlite');
    const s = createVectorStore('sqlite', { url: ':memory:' });
    expect(s.id).toBe('sqlite');
    expect(s.capabilities().persistent).toBe(true);
  });

  for (const c of vectorStoreConformance(() => new SqliteVectorStore({ url: ':memory:' }), {
    dims: 8,
  }))
    it(`conformance (memory file): ${c.name}`, c.run);
  for (const c of vectorStoreConformance(
    () => new SqliteVectorStore({ url: join(root, 'conf', 'store.sqlite') }),
    { dims: 8 },
  ))
    it(`conformance (file): ${c.name}`, c.run);

  it('persists across instances, lists chunks, exposes get()/has()/size(), filters by where/urls', async () => {
    const url = join(root, 'p', 'store.sqlite');
    const a = new SqliteVectorStore({ url, collection: 'c1' });
    await a.init(8, 'toy');
    await a.upsert([mk('a', 1, 's1'), mk('b', 2, 's1'), mk('c', 3, 's2', 'other lang')]);
    expect(a.size()).toBe(3);
    await a.close();

    const b = new SqliteVectorStore({ url, collection: 'c1' });
    await b.init(8, 'toy');
    expect(b.size()).toBe(3);
    const top = await b.query(vec(2), { topK: 2 });
    expect(top[0]?.id).toBe('b');
    expect(top[0]?.score).toBeGreaterThan(0.99);
    expect(top[0]?.vector).toBeInstanceOf(Float32Array);
    expect((await b.has(['a', 'nope'])).has('a')).toBe(true);
    expect(b.get('c')?.metadata.sessionId).toBe('s2');
    expect(b.get('c')?.vector?.length).toBe(8);
    const listed = await b.listChunks('s1');
    expect(listed.map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(listed[0]?.vector).toBeUndefined();
    expect((await b.listChunks()).length).toBe(3);
    const filtered = await b.query(vec(3), { topK: 3, filter: { where: { sessionId: 's1' } } });
    expect(filtered.every((r) => r.metadata.sessionId === 's1')).toBe(true);
    const byUrl = await b.query(vec(1), { topK: 3, filter: { urls: ['https://example.com/c'] } });
    expect(byUrl.map((r) => r.id)).toEqual(['c']);
    // another collection in the same file is independent
    const other = new SqliteVectorStore({ url, collection: 'c2' });
    await other.init(4, 'small');
    expect(other.size()).toBe(0);
    await other.close();
    // dimension mismatch on init
    const bad = new SqliteVectorStore({ url, collection: 'c1' });
    await expect(bad.init(16, 'big')).rejects.toMatchObject({
      code: 'EMBEDDING_DIMENSION_MISMATCH',
    });
    await bad.close();
    await b.close();
  });

  it('expires stale session rows on disk (retaining "persistent") and lists sessions', async () => {
    const s = new SqliteVectorStore({ url: ':memory:', sessionTtlMs: 1000 });
    await s.init(8, 'toy');
    await s.upsert([mk('a', 1, 'old'), mk('b', 2, 'persistent'), mk('c', 3, 'fresh')]);
    expect(
      s
        .listSessions()
        .map((x) => x.id)
        .sort(),
    ).toEqual(['fresh', 'old', 'persistent']);
    expect(s.expireSessions(Date.now() + 2000)).toBe(2); // old + fresh are older than 1 s at t+2 s
    expect(s.size()).toBe(1);
    expect(s.get('b')).toBeDefined();
    await s.close();
  });

  it('options.vec without sqlite-vec installed falls back to JS cosine (still works)', async () => {
    const s = new SqliteVectorStore({
      url: ':memory:',
      options: { vec: true },
      logger: silentLogger,
    });
    await s.init(8, 'toy');
    await s.upsert([mk('a', 1), mk('b', 2)]);
    const r = await s.query(vec(1), { topK: 1 });
    expect(r[0]?.id).toBe('a');
    expect(typeof s.accelerated).toBe('boolean');
    await s.close();
  });
});

d('sqlite store through the pipeline (session restore, BM25 rebuild)', () => {
  const KEYS = ['fusion', 'rank', 'banana', 'weather', 'python', 'formula'];
  const toy = customEmbeddingProvider(
    'toy',
    'toy-1',
    async (texts) =>
      texts.map((t) => KEYS.map((k) => (t.toLowerCase().split(k).length - 1) * 1.0 + 0.01)),
    { dimensions: 6 },
  );
  const page = (title: string, paras: string[]) =>
    `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${paras.map((p) => `<p>${p} ${'Additional filler sentence to make the paragraph long enough for extraction. '.repeat(6)}</p>`).join('')}</article></body></html>`;
  const SITES: Record<string, string> = {
    'https://rrf.example/intro': page('RRF intro', [
      'Reciprocal rank fusion combines ranked lists. The rank of each document matters.',
    ]),
    'https://fruit.example/banana': page('Bananas', ['Banana banana banana is a fruit.']),
  };
  let fetches = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    fetches++;
    return new Response(SITES[url] ?? 'nf', {
      status: SITES[url] ? 200 : 404,
      headers: { 'content-type': 'text/html' },
    });
  };
  const search = customSearchProvider('mock', async () =>
    Object.keys(SITES).map((url, i) => ({ url, title: url, rank: i + 1 })),
  );
  const make = (url: string, mode: 'session' | 'persistent') =>
    new WebVector(
      {
        search: { instance: search, fallbackProviders: [] },
        embeddings: { instance: toy, cache: false },
        store: { provider: 'sqlite', url, mode, sessionTtlMs: 60_000 },
        ingestion: {
          respectRobotsTxt: false,
          perHostMinIntervalMs: 0,
          retries: 0,
          allowPrivateNetworks: true,
          minChunkChars: 20,
          chunkSize: 80,
          cache: { enabled: false },
        },
        retrieval: { relativeCutoff: 0, mmr: false, queryExpansion: false },
        logger: silentLogger,
        fetch: fetchImpl,
      },
      { env: {} },
    );

  it('a new process restores the session from disk: no refetch, BM25 + vectors answer', async () => {
    const url = join(root, 'pipe', 'store.sqlite');
    const wv1 = make(url, 'persistent');
    const a = await wv1.research('rank fusion');
    expect(a.passages.length).toBeGreaterThan(0);
    expect(a.stats.ingest.cached).toBe(0);
    const fetchedFirst = fetches;
    await wv1.close();

    const wv2 = make(url, 'persistent');
    const b = await wv2.research('banana fruit');
    expect(fetches).toBe(fetchedFirst); // pages already in the persistent session → nothing fetched
    expect(b.stats.ingest.cached).toBe(2);
    expect(b.sources.every((s) => s.status === 'cached')).toBe(true);
    expect(b.passages.length).toBeGreaterThan(0);
    expect(b.passages[0]?.url).toContain('fruit.example');
    const sessions = await wv2.listSessions();
    expect(sessions[0]?.chunks).toBeGreaterThan(0);
    expect(sessions[0]?.urls).toBe(2);
    await wv2.close();

    // Explicit sessionId in session mode is restored the same way; other ids start empty.
    const wv3 = make(url, 'session');
    const c = await wv3.research('rank fusion', { sessionId: 'persistent' });
    expect(fetches).toBe(fetchedFirst);
    expect(c.stats.ingest.cached).toBe(2);
    const dd = await wv3.research('rank fusion', { sessionId: 'fresh-session' });
    expect(dd.stats.ingest.cached).toBe(0);
    expect(fetches).toBe(fetchedFirst + 2);
    await wv3.close();
  });
});
