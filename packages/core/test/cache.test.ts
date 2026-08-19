import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CacheDb, openCacheDb, resolveCacheDir } from '../src/cache/db.js';
import {
  type CachedPage,
  Fetcher,
  ingestUrl,
  PageCache,
  pageValidatorsFrom,
} from '../src/ingest/index.js';
import {
  defaultCacheDir,
  defaultDataDir,
  probeRuntime,
  withSqliteWarningFilter,
} from '../src/runtime.js';

const caps = await probeRuntime();
const sqliteIt = caps.sqlite ? it : it.skip;

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wv-cache-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const mkPage = (
  url: string,
  md = 'Hello **world**',
  extra: Partial<CachedPage> = {},
): CachedPage => ({
  doc: {
    url,
    title: 'T',
    markdown: md,
    text: md,
    contentType: 'text/html',
    parser: 'html',
    siteName: 'Example',
  },
  pageHash: 'h',
  fetchedAt: new Date().toISOString(),
  bytes: md.length,
  finalUrl: url,
  ...extra,
});

describe('runtime / XDG', () => {
  it('resolves cache and data dirs from XDG_* or ~ defaults', () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: '/x/cache' })).toBe('/x/cache/webvector');
    expect(defaultCacheDir({ XDG_CACHE_HOME: 'relative/ignored' })).toMatch(/\.cache\/webvector$/);
    expect(defaultDataDir({ XDG_DATA_HOME: '/x/data' })).toBe('/x/data/webvector');
    expect(defaultDataDir({})).toMatch(/\.local\/share\/webvector$/);
    expect(resolveCacheDir(false)).toBeUndefined();
    expect(resolveCacheDir('auto', { XDG_CACHE_HOME: '/x/cache' })).toBe('/x/cache/webvector');
    expect(resolveCacheDir('/explicit')).toBe('/explicit');
  });
  it('probe reports node:sqlite and SSRF mode', () => {
    expect(typeof caps.sqlite).toBe('boolean');
    expect(['connect-time', 'resolve-then-check', 'hostname-only']).toContain(caps.ssrfMode);
  });
  it('filters only the node:sqlite ExperimentalWarning (Node 22.x) and restores emitWarning', async () => {
    const seen: string[] = [];
    const onWarning = (w: Error) => {
      seen.push(`${w.name}:${w.message}`);
    };
    process.on('warning', onWarning);
    const original = process.emitWarning;
    await withSqliteWarningFilter(async () => {
      process.emitWarning(
        'SQLite is an experimental feature and might change at any time',
        'ExperimentalWarning',
      );
      process.emitWarning('something else', 'ExperimentalWarning');
      process.emitWarning('SQLite mentioned but not experimental', 'DeprecationWarning');
    });
    expect(process.emitWarning).toBe(original);
    process.emitWarning('SQLite is an experimental feature (after)', 'ExperimentalWarning');
    await new Promise((r) => setImmediate(r));
    process.off('warning', onWarning);
    expect(seen).toContain('ExperimentalWarning:something else');
    expect(seen).toContain('DeprecationWarning:SQLite mentioned but not experimental');
    expect(seen).toContain('ExperimentalWarning:SQLite is an experimental feature (after)');
    expect(seen.some((s) => s.includes('might change at any time'))).toBe(false);
  });
});

describe('pageValidatorsFrom', () => {
  it('reads ETag, Last-Modified and max-age (ignoring no-store/private)', () => {
    const h = new Headers({
      etag: 'W/"abc"',
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
      'cache-control': 'public, max-age=3600',
    });
    expect(pageValidatorsFrom(h)).toEqual({
      etag: 'W/"abc"',
      lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
      maxAgeMs: 3_600_000,
    });
    expect(pageValidatorsFrom(new Headers({ 'cache-control': 'no-store, max-age=10' }))).toEqual(
      {},
    );
    expect(pageValidatorsFrom(new Headers({ 'last-modified': 'garbage' }))).toEqual({});
    expect(pageValidatorsFrom(undefined)).toEqual({});
  });
});

describe('PageCache (memory)', () => {
  it('memory-only when dir is false; per-call policy controls freshness', async () => {
    const c = await PageCache.create({ enabled: true, ttlMs: 1000, maxPages: 10, dir: false });
    expect(c.backend).toBe('memory');
    const url = 'https://example.com/a?utm_source=x';
    c.set(url, mkPage(url));
    expect(c.get('https://example.com/a')).toBeDefined(); // canonicalised key
    const old = mkPage('https://example.com/old');
    old.fetchedAt = new Date(Date.now() - 5000).toISOString();
    c.set(old.doc.url, old);
    expect(c.get(old.doc.url)).toBeUndefined(); // past ttl
    expect(c.getStale(old.doc.url)).toBeDefined();
    expect(c.get(old.doc.url, { mode: 'readOnly' })).toBeDefined(); // stale ok in readOnly
    expect(c.get(old.doc.url, { maxAgeMs: 10_000 })).toBeDefined(); // per-call window
    expect(c.get(url, { mode: 'bypass' })).toBeUndefined();
    expect(c.get(url, { maxAgeMs: 0 })).toBeUndefined();
    // Cache-Control max-age longer than the TTL keeps a page fresh
    const cc = mkPage('https://example.com/cc', 'x', { maxAgeMs: 60_000 });
    cc.fetchedAt = new Date(Date.now() - 5000).toISOString();
    c.set(cc.doc.url, cc);
    expect(c.get(cc.doc.url)).toBeDefined();
    expect(c.counters.hits).toBeGreaterThan(0);
  });
  it('disabled cache never stores', async () => {
    const c = await PageCache.create({ enabled: false, ttlMs: 0, maxPages: 10 });
    expect(c.backend).toBe('disabled');
    c.set('https://e.com/', mkPage('https://e.com/'));
    expect(c.get('https://e.com/')).toBeUndefined();
  });
});

describe('PageCache (sqlite)', () => {
  sqliteIt('persists pages across instances in pages.sqlite and honours XDG auto dir', async () => {
    const env = { XDG_CACHE_HOME: join(root, 'xdg') };
    const a = await PageCache.create({
      enabled: true,
      ttlMs: 60_000,
      maxPages: 10,
      dir: 'auto',
      env,
    });
    expect(a.backend).toBe('sqlite');
    expect(a.location).toBe(join(root, 'xdg', 'webvector', 'pages.sqlite'));
    const url = 'https://example.com/persist';
    a.set(url, mkPage(url, '# Title\n\nBody text', { etag: '"e1"', maxAgeMs: 120_000 }));
    a.database?.close();

    const b = await PageCache.create({
      enabled: true,
      ttlMs: 60_000,
      maxPages: 10,
      dir: 'auto',
      env,
    });
    const hit = b.get(url);
    expect(hit?.doc.markdown).toBe('# Title\n\nBody text');
    expect(hit?.doc.siteName).toBe('Example');
    expect(hit?.doc.text.length).toBeGreaterThan(0);
    expect(hit?.etag).toBe('"e1"');
    expect(hit?.maxAgeMs).toBe(120_000);
    expect(b.counters.diskHits).toBe(1);
    expect(b.get(url)).toBeDefined(); // now from memory
    expect(b.counters.diskHits).toBe(1);
    expect(b.delete(url)).toBe(true);
    expect(b.get(url)).toBeUndefined();
    b.database?.close();
  });

  sqliteIt('explicit dir → sqlite file there; no JSON files are written', async () => {
    const dir = join(root, 'explicit');
    const c = await PageCache.create({ enabled: true, ttlMs: 60_000, maxPages: 10, dir });
    expect(c.backend).toBe('sqlite');
    c.set('https://example.com/j', mkPage('https://example.com/j'));
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
    expect(existsSync(join(dir, 'pages.sqlite'))).toBe(true);
    c.database?.close();
  });

  sqliteIt('CacheDb: LRU eviction by budget, prune, stats, restamp', async () => {
    const db = (await openCacheDb({ dir: join(root, 'db') })) as CacheDb;
    expect(db).toBeDefined();
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      db.putPage({
        url_key: `k${i}`,
        url: `https://h${i % 2}.example/${i}`,
        final_url: `https://h${i % 2}.example/${i}`,
        fetched_at: now - (10 - i) * 1000,
        last_access: now - (10 - i) * 1000,
        etag: null,
        last_modified: null,
        max_age_ms: null,
        content_type: 'text/html',
        title: `t${i}`,
        markdown: 'x'.repeat(100),
        bytes: 100,
        md_bytes: 100,
        page_hash: 'p',
        meta: '{}',
      });
    }
    expect(db.pageTotals()).toEqual({ count: 10, markdownBytes: 1000 });
    expect(db.evictPages(4, 10_000)).toBe(6); // keep 4 most recent
    expect(db.pageTotals().count).toBe(4);
    expect(db.getPage('k9')).toBeDefined();
    expect(db.getPage('k0')).toBeUndefined();
    expect(db.evictPages(100, 250)).toBe(2); // byte budget: 2 × 100 fit
    expect(db.pageTotals().count).toBe(2);
    db.restampPage('k9', now + 5000, { etag: '"new"' });
    expect(db.getPage('k9')?.etag).toBe('"new"');
    expect(db.getPage('k9')?.fetched_at).toBe(now + 5000);
    const s = db.stats();
    expect(s.pages.count).toBe(2);
    expect(s.hosts.length).toBeGreaterThan(0);
    expect(s.path.endsWith('pages.sqlite')).toBe(true);
    expect(db.prunePages(3000, now + 5000)).toBe(1); // k8 (fetched 2 s before now) is older than 3 s at now+5s
    expect(db.listPages()).toHaveLength(1);
    expect(db.clearPages()).toBe(1);
    // embeddings
    db.putEmbeddings([
      {
        model: 'm',
        dims: 3,
        dtype: 'fp32',
        role: 'document',
        hash: 'h1',
        vec: new Float32Array([1, 2, 3]),
      },
    ]);
    expect(Array.from(db.getEmbedding('m', 3, 'fp32', 'document', 'h1') as Float32Array)).toEqual([
      1, 2, 3,
    ]);
    expect(db.getEmbedding('m', 4, 'fp32', 'document', 'h1')).toBeUndefined(); // dims part of key
    expect(db.stats().embeddings.count).toBe(1);
    expect(db.clearEmbeddings()).toBe(1);
    db.close();
  });
});

describe('ingestUrl + cache policy + revalidation', () => {
  const html = (t: string) =>
    `<!doctype html><html><head><title>${t}</title></head><body><article><h1>${t}</h1><p>${'Reciprocal rank fusion combines ranked lists from several retrieval systems into one. '.repeat(8)}</p></article></body></html>`;

  function setup(dir: string | false) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    let mode: 'fresh' | '304' | 'changed' = 'fresh';
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      calls.push({ url, headers });
      if (mode === '304' && headers['if-none-match'] === '"v1"')
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      const body = mode === 'changed' ? html('Changed') : html('Original');
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          etag: mode === 'changed' ? '"v2"' : '"v1"',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
        },
      });
    };
    const fetcher = new Fetcher({
      userAgent: 'test',
      timeoutMs: 5000,
      maxRedirects: 3,
      maxBytes: 1_000_000,
      maxConcurrentFetches: 4,
      perHostConcurrency: 2,
      perHostMinIntervalMs: 0,
      respectRobotsTxt: false,
      retries: 0,
      allowPrivateNetworks: true,
      fetch: fetchImpl,
    });
    return {
      calls,
      fetcher,
      setMode: (m: typeof mode) => {
        mode = m;
      },
      cache: PageCache.create({ enabled: true, ttlMs: 60_000, maxPages: 10, dir }),
    };
  }

  it('fresh hit → no request; stale + ETag → conditional GET, 304 re-stamps; changed → new page', async () => {
    const s = setup(false);
    const cache = await s.cache;
    const url = 'https://example.com/doc';
    const first = await ingestUrl(url, { fetcher: s.fetcher, cache });
    expect(first.ok && !first.cached).toBe(true);
    expect(first.page?.etag).toBe('"v1"');
    expect(first.page?.lastModified).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(s.calls).toHaveLength(1);

    const second = await ingestUrl(url, { fetcher: s.fetcher, cache });
    expect(second.cached).toBe(true);
    expect(s.calls).toHaveLength(1);

    // Age the entry past the TTL, then revalidate: server says 304.
    const stale = cache.getStale(url) as CachedPage;
    stale.fetchedAt = new Date(Date.now() - 120_000).toISOString();
    cache.set(url, stale);
    s.setMode('304');
    const third = await ingestUrl(url, { fetcher: s.fetcher, cache });
    expect(third.cached).toBe(true);
    expect(third.revalidated).toBe(true);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]?.headers['if-none-match']).toBe('"v1"');
    expect(s.calls[1]?.headers['if-modified-since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(Date.now() - Date.parse(third.page?.fetchedAt as string)).toBeLessThan(5000);
    expect(cache.counters.notModified).toBe(1);

    // Age again; this time the origin returns a changed 200 → parsed and stored, not "cached".
    const stale2 = cache.getStale(url) as CachedPage;
    stale2.fetchedAt = new Date(Date.now() - 120_000).toISOString();
    cache.set(url, stale2);
    s.setMode('changed');
    const fourth = await ingestUrl(url, { fetcher: s.fetcher, cache });
    expect(fourth.ok).toBe(true);
    expect(fourth.cached).toBeFalsy();
    expect(fourth.page?.doc.title).toBe('Changed');
    expect(fourth.page?.etag).toBe('"v2"');
    expect(cache.get(url)?.etag).toBe('"v2"');
  });

  it('cacheMode bypass ignores the cache; readOnly never fetches (CACHE_MISS on miss)', async () => {
    const s = setup(false);
    const cache = await s.cache;
    const url = 'https://example.com/policy';
    const miss = await ingestUrl(url, {
      fetcher: s.fetcher,
      cache,
      cachePolicy: { mode: 'readOnly' },
    });
    expect(miss.ok).toBe(false);
    expect(miss.failure?.code).toBe('CACHE_MISS');
    expect(s.calls).toHaveLength(0);
    await ingestUrl(url, { fetcher: s.fetcher, cache });
    expect(s.calls).toHaveLength(1);
    const ro = await ingestUrl(url, {
      fetcher: s.fetcher,
      cache,
      cachePolicy: { mode: 'readOnly' },
    });
    expect(ro.cached).toBe(true);
    const by = await ingestUrl(url, { fetcher: s.fetcher, cache, cachePolicy: { mode: 'bypass' } });
    expect(by.cached).toBeFalsy();
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]?.headers['if-none-match']).toBeUndefined();
    const young = await ingestUrl(url, { fetcher: s.fetcher, cache, cachePolicy: { maxAgeMs: 0 } });
    expect(young.cached).toBeFalsy(); // maxAgeMs 0 = must be fresher than anything cached
    expect(s.calls).toHaveLength(3);
  });

  sqliteIt('revalidation works from the disk layer after a restart', async () => {
    const dir = join(root, 'reval');
    const s = setup(dir);
    const cache = await s.cache;
    const url = 'https://example.com/disk';
    await ingestUrl(url, { fetcher: s.fetcher, cache });
    cache.database?.close();
    // New process: memory empty, disk has a (now artificially stale) entry with validators.
    const cache2 = await PageCache.create({ enabled: true, ttlMs: 1, maxPages: 10, dir });
    await new Promise((r) => setTimeout(r, 5));
    s.setMode('304');
    const out = await ingestUrl(url, { fetcher: s.fetcher, cache: cache2 });
    expect(out.revalidated).toBe(true);
    expect(s.calls).toHaveLength(2);
    cache2.database?.close();
  });
});
