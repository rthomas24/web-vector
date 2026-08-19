import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CacheDb, openCacheDb } from '../src/cache/db.js';
import { FetchCoordinator, isNegativeCacheable, SingleFlight } from '../src/cache/single-flight.js';
import { customEmbeddingProvider, EmbeddingCache } from '../src/embeddings/base.js';
import { WebVector } from '../src/pipeline/webvector.js';
import { probeRuntime } from '../src/runtime.js';
import { customSearchProvider } from '../src/search/providers.js';
import type { UsageStats } from '../src/types.js';
import { DEFAULT_PRICING, estimateCostUsd, resolvePricing } from '../src/usage/pricing.js';
import { silentLogger } from '../src/util/logger.js';

const KEYS = ['fusion', 'rank', 'banana', 'weather', 'python', 'formula'];
const toyEmbedder = customEmbeddingProvider(
  'toy',
  'toy-1',
  async (texts) =>
    texts.map((t) => {
      const l = t.toLowerCase();
      return KEYS.map((k) => (l.split(k).length - 1) * 1.0 + 0.01);
    }),
  { dimensions: 6, limits: { maxBatchSize: 64 } },
);

const page = (title: string, paras: string[]) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${paras.map((p) => `<p>${p} ${'Additional filler sentence to make the paragraph long enough for extraction. '.repeat(6)}</p>`).join('')}</article></body></html>`;

const SITES: Record<string, string> = {
  'https://rrf.example/intro': page('RRF intro', [
    'Reciprocal rank fusion combines ranked lists. The rank of each document matters.',
    'The formula for rank fusion uses 1/(k+rank).',
  ]),
  'https://fruit.example/banana': page('Bananas', [
    'Banana banana banana is a fruit.',
    'Weather affects banana crops.',
  ]),
  'https://py.example/doc': page('Python docs', ['Python is a programming language.']),
};

function makeFetch(opts: { delayMs?: number; etag?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url, headers });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    if (url.includes('/missing')) return new Response('nope', { status: 404 });
    if (url.includes('/flaky')) return new Response('nope', { status: 503 });
    const body = SITES[url];
    if (!body) return new Response('nf', { status: 404 });
    if (opts.etag && headers['if-none-match'] === '"v1"')
      return new Response(null, { status: 304 });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...(opts.etag ? { etag: '"v1"' } : {}),
      },
    });
  };
  return { calls, fetchImpl, pageCalls: () => calls.filter((c) => !c.url.endsWith('robots.txt')) };
}

let searchCalls = 0;
const search = customSearchProvider('mock', async () => {
  searchCalls++;
  await new Promise((r) => setTimeout(r, 5));
  return Object.keys(SITES).map((url, i) => ({ url, title: url, rank: i + 1 }));
});

function make(fetchImpl: typeof fetch, extra: ConstructorParameters<typeof WebVector>[0] = {}) {
  return new WebVector(
    {
      search: { instance: search, fallbackProviders: [] },
      embeddings: { instance: toyEmbedder },
      ingestion: {
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        timeoutMs: 1500,
        totalDeadlineMs: 5000,
        minChunkChars: 20,
        chunkSize: 80,
        allowPrivateNetworks: true,
        cache: { dir: false },
      },
      retrieval: { maxPerSource: 3, relativeCutoff: 0, mmr: false, queryExpansion: false },
      logger: silentLogger,
      fetch: fetchImpl,
      ...extra,
    },
    { env: {} },
  );
}

describe('stats.usage / stats.http / cache policy through research()', () => {
  it('counts requests on the first run, cache hits on the second, and marks sources fromCache', async () => {
    const f = makeFetch();
    const wv = make(f.fetchImpl);
    const events: UsageStats[] = [];
    wv.on('usage', (u) => events.push(u));
    const a = await wv.research('rank fusion');
    expect(a.stats.usage?.http.requests).toBe(3);
    expect(a.stats.usage?.http.cacheHits).toBe(0);
    expect(a.stats.usage?.http.bytes).toBeGreaterThan(0);
    expect(a.stats.http).toBe(a.stats.usage?.http);
    expect(a.stats.usage?.search).toEqual({ provider: 'mock', calls: 1 });
    expect(a.stats.usage?.embed.provider).toBe('toy');
    expect(a.stats.usage?.embed.requests).toBeGreaterThan(0);
    expect(a.stats.usage?.embed.tokens).toBeGreaterThan(0);
    expect(a.sources.every((s) => s.fromCache === false)).toBe(true);
    const embedTextsFirst = a.stats.usage?.embed.texts as number;

    const b = await wv.research('rank fusion');
    expect(b.stats.usage?.http.requests).toBe(0);
    expect(b.stats.usage?.http.cacheHits).toBe(3);
    expect(b.sources.every((s) => s.fromCache === true && s.status === 'cached')).toBe(true);
    expect(b.stats.embed.cached).toBeGreaterThan(0);
    expect(b.stats.usage?.embed.cached).toBe(b.stats.embed.cached);
    expect(b.stats.usage?.embed.texts).toBeLessThan(embedTextsFirst); // only queries embedded
    expect(events).toHaveLength(2);
    expect(f.pageCalls()).toHaveLength(3);

    // bypass → refetch everything; maxAgeMs: 0 → likewise
    const c = await wv.research('rank fusion', { cacheMode: 'bypass' });
    expect(c.stats.usage?.http.requests).toBe(3);
    expect(f.pageCalls()).toHaveLength(6);
    const d = await wv.research('rank fusion', { maxAgeMs: 0 });
    expect(d.stats.usage?.http.requests).toBe(3);
    // readOnly with a warm cache → all hits, no network
    const e = await wv.research('rank fusion', { cacheMode: 'readOnly' });
    expect(e.stats.usage?.http.requests).toBe(0);
    expect(e.stats.usage?.http.cacheHits).toBe(3);
    await wv.close();
  });

  it('readOnly on a cold cache never touches the network and degrades to snippets', async () => {
    const f = makeFetch();
    const wv = make(f.fetchImpl);
    const r = await wv.research('rank fusion', { cacheMode: 'readOnly' });
    expect(f.pageCalls()).toHaveLength(0);
    expect(r.failures.filter((x) => x.code === 'CACHE_MISS')).toHaveLength(3);
    expect(r.degraded).toBe('search_only');
    await expect(wv.fetch('https://rrf.example/intro', { cacheMode: 'readOnly' })).rejects.toThrow(
      /readOnly/,
    );
    await wv.close();
  });

  it('revalidates stale pages with If-None-Match and reports notModified', async () => {
    const f = makeFetch({ etag: true });
    const wv = make(f.fetchImpl, {
      ingestion: {
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        allowPrivateNetworks: true,
        minChunkChars: 20,
        chunkSize: 80,
        cache: { dir: false, ttlMs: 1 },
      },
    });
    await wv.research('rank fusion');
    await new Promise((r) => setTimeout(r, 5));
    const b = await wv.research('rank fusion');
    expect(b.stats.usage?.http.notModified).toBe(3);
    expect(b.stats.usage?.http.requests).toBe(3);
    expect(b.stats.usage?.http.cacheHits).toBe(0);
    expect(b.sources.every((s) => s.fromCache && s.revalidated)).toBe(true);
    expect(b.stats.ingest.cached).toBe(3);
    expect(f.pageCalls().filter((c) => c.headers['if-none-match'] === '"v1"')).toHaveLength(3);
    await wv.close();
  });

  it('single-flight: concurrent identical fetches share one request; searches too', async () => {
    const f = makeFetch({ delayMs: 30 });
    const wv = make(f.fetchImpl);
    const before = searchCalls;
    const [x, y] = await Promise.all([
      wv.fetch('https://rrf.example/intro'),
      wv.fetch('https://rrf.example/intro?utm_source=x'),
    ]);
    expect(x.title).toBe(y.title);
    expect(f.pageCalls()).toHaveLength(1);
    const [r1, r2] = await Promise.all([wv.research('rank fusion'), wv.research('rank fusion')]);
    expect(searchCalls - before).toBe(1); // coalesced search
    // pages were already cached by fetch()/first research → no extra requests overall
    expect(f.pageCalls()).toHaveLength(3);
    const coalesced = (r1.stats.usage?.http.coalesced ?? 0) + (r2.stats.usage?.http.coalesced ?? 0);
    expect(coalesced).toBeGreaterThanOrEqual(1);
    await wv.close();
  });

  it('negative cache: a 4xx URL is not re-fetched within the window; 5xx is retried', async () => {
    const f = makeFetch();
    const wv = make(f.fetchImpl);
    await expect(wv.fetch('https://x.example/missing')).rejects.toThrow(/404/);
    await expect(wv.fetch('https://x.example/missing')).rejects.toThrow(/404/);
    expect(f.pageCalls().filter((c) => c.url.includes('/missing'))).toHaveLength(1);
    await expect(wv.fetch('https://x.example/flaky')).rejects.toThrow(/503/);
    await expect(wv.fetch('https://x.example/flaky')).rejects.toThrow(/503/);
    expect(f.pageCalls().filter((c) => c.url.includes('/flaky'))).toHaveLength(2);
    // bypass skips the negative cache
    await expect(wv.fetch('https://x.example/missing', { cacheMode: 'bypass' })).rejects.toThrow(
      /404/,
    );
    expect(f.pageCalls().filter((c) => c.url.includes('/missing'))).toHaveLength(2);
    await wv.close();
  });

  it('pricing: opt-in estimate from the static table, clearly labelled', async () => {
    const f = makeFetch();
    const wv = make(f.fetchImpl, {
      telemetry: { pricing: { search: { mock: 10 }, embed: { 'toy/toy-1': 1 } } },
    });
    const r = await wv.research('rank fusion');
    const u = r.stats.usage as UsageStats;
    expect(u.estimatedCostUsd).toBeGreaterThan(0);
    expect(u.pricingNote).toMatch(/estimate/i);
    const expected = (u.search.calls / 1000) * 10 + ((u.embed.tokens ?? 0) / 1e6) * 1;
    expect(u.estimatedCostUsd).toBeCloseTo(expected, 6);
    await wv.close();
    // Not enabled → no estimate
    const wv2 = make(f.fetchImpl);
    const r2 = await wv2.research('rank fusion');
    expect(r2.stats.usage?.estimatedCostUsd).toBeUndefined();
    await wv2.close();
  });
});

describe('pricing table helpers', () => {
  it('estimates from provider/model keys with wildcard fallback and user overrides', () => {
    const usage: UsageStats = {
      search: { provider: 'brave', calls: 2 },
      embed: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        requests: 1,
        texts: 10,
        tokens: 1_000_000,
        cached: 0,
      },
      rerank: { provider: 'cohere', requests: 1, documents: 20 },
      http: { requests: 0, bytes: 0, cacheHits: 0, notModified: 0, coalesced: 0, negativeHits: 0 },
    };
    const usd = estimateCostUsd(usage, DEFAULT_PRICING) as number;
    expect(usd).toBeCloseTo(0.01 + 0.02 + 0.002, 6);
    const local = { ...usage, embed: { ...usage.embed, provider: 'local', model: 'anything' } };
    expect(estimateCostUsd(local, DEFAULT_PRICING)).toBeCloseTo(0.012, 6);
    const custom = resolvePricing({ search: { brave: 0 } });
    expect(estimateCostUsd({ ...usage, rerank: undefined }, custom)).toBeCloseTo(0.02, 6);
    const unknown = { ...usage, search: { provider: 'nope', calls: 5 }, rerank: undefined };
    unknown.embed = { ...unknown.embed, provider: 'zzz' };
    expect(estimateCostUsd(unknown, DEFAULT_PRICING)).toBeUndefined();
  });
});

describe('SingleFlight / negative cache primitives', () => {
  it('shares in-flight promises and reports joins', async () => {
    const sf = new SingleFlight();
    let runs = 0;
    const fn = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 10));
      return runs;
    };
    const [a, b] = await Promise.all([sf.run('k', fn), sf.run('k', fn)]);
    expect(a).toBe(b);
    expect(runs).toBe(1);
    expect(sf.joined).toBe(1);
    expect(sf.size).toBe(0);
    await sf.run('k', fn);
    expect(runs).toBe(2);
  });
  it('isNegativeCacheable: robots/ssrf/4xx yes; 429/408/5xx/network no', () => {
    const f = (code: string, message = '') => ({ code, message, stage: 'ingest' as const });
    expect(isNegativeCacheable(f('FETCH_BLOCKED_ROBOTS'))).toBe(true);
    expect(isNegativeCacheable(f('FETCH_BLOCKED_SSRF'))).toBe(true);
    expect(isNegativeCacheable(f('FETCH_HTTP_ERROR', 'HTTP 404 fetching x'))).toBe(true);
    expect(isNegativeCacheable(f('FETCH_HTTP_ERROR', 'HTTP 408 fetching x'))).toBe(false);
    expect(isNegativeCacheable(f('FETCH_HTTP_ERROR', 'HTTP 503 fetching x'))).toBe(false);
    expect(isNegativeCacheable(f('PROVIDER_RATE_LIMITED', 'HTTP 429'))).toBe(false);
    expect(isNegativeCacheable(f('FETCH_FAILED'))).toBe(false);
  });
  it('FetchCoordinator remembers negative outcomes for the TTL only', async () => {
    const co = new FetchCoordinator({ negativeTtlMs: 30 });
    let calls = 0;
    const fail = async () => {
      calls++;
      return {
        url: 'u',
        ok: false,
        failure: {
          url: 'u',
          code: 'FETCH_HTTP_ERROR',
          message: 'HTTP 404 fetching u',
          stage: 'ingest' as const,
        },
        ms: 0,
      };
    };
    await co.ingest('u', fail);
    await co.ingest('u', fail);
    expect(calls).toBe(1);
    expect(co.counters.negativeHits).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    await co.ingest('u', fail);
    expect(calls).toBe(2);
    await co.ingest('u', fail, { bypassNegative: true });
    expect(calls).toBe(3);
  });
});

const caps = await probeRuntime();
const sqliteIt = caps.sqlite ? it : it.skip;

describe('persistent embedding cache (F3)', () => {
  sqliteIt(
    'EmbeddingCache: write-through to pages.sqlite keyed by model/dims/dtype/role/hash',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wv-emb-'));
      const db = (await openCacheDb({ dir })) as CacheDb;
      const a = new EmbeddingCache({ db, dims: 3, dtype: 'q8', batchSize: 100 });
      expect(a.persistent).toBe(true);
      a.set('m', 'h1', 'document', new Float32Array([1, 2, 3]));
      expect(db.stats().embeddings.count).toBe(0); // batched
      expect(a.flush()).toBe(1);
      expect(db.stats().embeddings.count).toBe(1);
      const b = new EmbeddingCache({ db, dims: 3, dtype: 'q8' });
      expect(Array.from(b.get('m', 'h1', 'document') as Float32Array)).toEqual([1, 2, 3]);
      expect(b.diskHits).toBe(1);
      expect(b.get('m', 'h1', 'document')).toBeDefined();
      expect(b.diskHits).toBe(1); // promoted to memory
      expect(
        new EmbeddingCache({ db, dims: 2, dtype: 'q8' }).get('m', 'h1', 'document'),
      ).toBeUndefined();
      expect(
        new EmbeddingCache({ db, dims: 3, dtype: 'fp32' }).get('m', 'h1', 'document'),
      ).toBeUndefined();
      expect(b.get('m', 'h1', 'query')).toBeUndefined();
      const mem = new EmbeddingCache(10);
      expect(mem.persistent).toBe(false);
      mem.set('m', 'h', 'document', new Float32Array([1]));
      expect(mem.flush()).toBe(0);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  );

  sqliteIt(
    'a fresh WebVector instance re-uses chunk embeddings from disk (stats.embed.cached)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'wv-emb2-'));
      const f = makeFetch();
      const cfg = {
        ingestion: {
          respectRobotsTxt: false,
          perHostMinIntervalMs: 0,
          retries: 0,
          allowPrivateNetworks: true,
          minChunkChars: 20,
          chunkSize: 80,
          cache: { dir },
        },
      };
      const wv1 = make(f.fetchImpl, cfg);
      const a = await wv1.research('rank fusion');
      expect(a.stats.embed.chunks).toBeGreaterThan(0);
      expect(a.stats.embed.cached).toBe(0);
      await wv1.close();
      const wv2 = make(f.fetchImpl, cfg);
      const b = await wv2.research('rank fusion');
      expect(b.stats.embed.cached).toBe(a.stats.embed.chunks); // every chunk vector came from disk
      expect(b.stats.embed.batches).toBe(0); // no embed request for documents
      expect(b.stats.usage?.embed.cached).toBe(a.stats.embed.chunks);
      await wv2.close();
      // embeddings.cache: false → nothing persisted for a third instance
      const wv3 = make(f.fetchImpl, {
        ...cfg,
        embeddings: { instance: toyEmbedder, cache: false },
      });
      const db = (await openCacheDb({ dir })) as CacheDb;
      db.clearEmbeddings();
      db.close();
      const c = await wv3.research('rank fusion');
      expect(c.stats.embed.cached).toBe(0);
      await wv3.close();
      const db2 = (await openCacheDb({ dir })) as CacheDb;
      expect(db2.stats().embeddings.count).toBe(0);
      db2.close();
      rmSync(dir, { recursive: true, force: true });
    },
  );
});
