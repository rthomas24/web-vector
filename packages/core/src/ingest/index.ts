import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CacheDb, openCacheDb, resolveCacheDir } from '../cache/db.js';
import { WebVectorError } from '../errors.js';
import type { ContentParser, Failure, Logger, ParsedDocument } from '../types.js';
import { sha256 } from '../util/hash.js';
import { LRU } from '../util/lru.js';
import { canonicalizeUrl } from '../util/url.js';
import { type FetchedResource, Fetcher, type FetcherOptions } from './fetcher.js';
import {
  cleanField,
  createParsers,
  markdownToText,
  sanitizeText,
  selectParser,
} from './parsers.js';

export type { ChunkerOptions, TextChunk, TokenCounter } from './chunker.js';
export { approxTokens, chunkMarkdown, loadTokenCounter } from './chunker.js';
export type { FetchedResource, FetcherOptions } from './fetcher.js';
export { Fetcher, parseContentType } from './fetcher.js';
export type { HtmlParserOptions } from './parsers.js';
export {
  createParsers,
  decodeBytes,
  HtmlParser,
  markdownToText,
  PdfParser,
  sanitizeText,
  selectParser,
  TextParser,
} from './parsers.js';
export { RobotsCache } from './robots.js';
export { assertSafeUrl, isPublicIp } from './ssrf.js';

/** HTTP validators / freshness hints stored with a cached page (conditional revalidation). */
export interface PageValidators {
  etag?: string;
  lastModified?: string;
  /** `Cache-Control: max-age` in ms when the origin sent one. */
  maxAgeMs?: number;
}

export interface CachedPage extends PageValidators {
  doc: ParsedDocument;
  pageHash: string;
  fetchedAt: string;
  bytes: number;
  finalUrl: string;
}

/** Per-call cache policy (`ResearchOptions.maxAgeMs` / `cacheMode`). */
export interface CachePolicy {
  /** Accept cached pages at most this old (overrides the configured TTL and Cache-Control). */
  maxAgeMs?: number;
  /**
   * `default`: fresh hit → serve; stale with validators → conditional GET (304 = hit); else fetch.
   * `bypass`: ignore cached copies (still writes the fresh page).
   * `readOnly`: only serve from cache, never hit the network (stale allowed; miss = CACHE_MISS).
   */
  mode?: 'default' | 'bypass' | 'readOnly';
}

export interface PageCacheOptions {
  enabled: boolean;
  ttlMs: number;
  maxPages: number;
  /** In-memory byte budget for cached page markdown (default 256 MB); oldest entries are evicted first. */
  maxBytes?: number;
  /**
   * On-disk layer: `'auto'` (default) → `pages.sqlite` under `$XDG_CACHE_HOME/webvector`, a path →
   * `pages.sqlite` there (JSON-per-URL fallback when node:sqlite is unavailable), `false` → memory only.
   */
  dir?: string | false;
  /** Disk budgets for the SQLite layer (defaults: 20 000 pages / 1 GiB of markdown). */
  maxDiskPages?: number;
  maxDiskBytes?: number;
  /** An already-open cache database to use (created by `PageCache.create`). */
  db?: CacheDb;
  env?: NodeJS.ProcessEnv;
}

export type CacheLookup =
  | { page: CachedPage; status: 'hit' | 'revalidated' | 'refetched'; failure?: undefined }
  | { failure: Failure; page?: undefined; status?: undefined };

/** Read `ETag` / `Last-Modified` / `Cache-Control: max-age` from response headers. */
export function pageValidatorsFrom(headers: Headers | undefined): PageValidators {
  if (!headers) return {};
  const out: PageValidators = {};
  const etag = headers.get('etag');
  if (etag) out.etag = etag;
  const lm = headers.get('last-modified');
  if (lm && Number.isFinite(Date.parse(lm))) out.lastModified = lm;
  const cc = headers.get('cache-control');
  if (cc && !/no-store|no-cache|private/i.test(cc)) {
    const m = /(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*(\d+)/i.exec(cc);
    if (m) out.maxAgeMs = Number(m[1]) * 1000;
  }
  return out;
}

/**
 * Page cache: in-process LRU (bytes-bounded) in front of an optional on-disk layer keyed by
 * canonical URL. The disk layer is a single SQLite file (`pages.sqlite`, WAL, multi-process safe)
 * when `node:sqlite` is available, else the legacy JSON-per-URL layout for explicit directories.
 * Construct directly for memory/JSON, or via `PageCache.create()` to open the SQLite layer.
 */
export class PageCache {
  private readonly lru: LRU<string, CachedPage>;
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxDiskPages: number;
  private readonly maxDiskBytes: number;
  private db?: CacheDb;
  private readonly jsonDir?: string;
  private writes = 0;
  /** Counters since construction (surfaced by `webvector cache stats` / doctor). */
  readonly counters = { hits: 0, diskHits: 0, misses: 0, stale: 0, notModified: 0, writes: 0 };

  constructor(private readonly opts: PageCacheOptions) {
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    this.maxDiskPages = opts.maxDiskPages ?? 20_000;
    this.maxDiskBytes = opts.maxDiskBytes ?? 1024 * 1024 * 1024;
    // No LRU TTL: freshness is decided per lookup (TTL / Cache-Control / per-call policy) so stale
    // entries stay available for conditional revalidation and `readOnly` mode.
    this.lru = new LRU(opts.maxPages, undefined, (_k, v) => {
      this.bytes -= v.doc.markdown.length;
    });
    this.db = opts.db;
    if (!this.db && typeof opts.dir === 'string' && opts.dir !== 'auto') {
      // Legacy JSON layout (also the fallback when node:sqlite is missing for an explicit dir).
      try {
        mkdirSync(opts.dir, { recursive: true });
        this.jsonDir = opts.dir;
      } catch {
        this.jsonDir = undefined;
      }
    }
  }

  /**
   * Open the on-disk layer: resolves `dir` ('auto' → XDG cache dir), tries `pages.sqlite`, and
   * falls back to the JSON layout (explicit dir) or memory only ('auto'). Never throws.
   */
  static async create(opts: PageCacheOptions, logger?: Logger): Promise<PageCache> {
    if (!opts.enabled || opts.db) return new PageCache(opts);
    const dir = resolveCacheDir(opts.dir ?? 'auto', opts.env);
    if (!dir) return new PageCache({ ...opts, dir: false });
    const db = await openCacheDb({ dir });
    if (db) return new PageCache({ ...opts, dir, db });
    if (opts.dir === 'auto' || opts.dir === undefined) {
      logger?.debug(`page cache: node:sqlite unavailable or ${dir} not writable — memory only`);
      return new PageCache({ ...opts, dir: false });
    }
    logger?.debug(`page cache: node:sqlite unavailable — using JSON files in ${dir}`);
    return new PageCache({ ...opts, dir });
  }

  /** Where pages persist: 'sqlite' | 'json' | 'memory' | 'disabled'. */
  get backend(): 'sqlite' | 'json' | 'memory' | 'disabled' {
    if (!this.opts.enabled) return 'disabled';
    if (this.db) return 'sqlite';
    if (this.jsonDir) return 'json';
    return 'memory';
  }
  /** Path of the SQLite file / JSON directory when persistent. */
  get location(): string | undefined {
    return this.db?.path ?? this.jsonDir;
  }
  /** The shared cache database (also used by the persistent embedding cache). */
  get database(): CacheDb | undefined {
    return this.db;
  }

  /** Effective freshness window for an entry under a policy (ms; Infinity = never expires). */
  private ttlFor(entry: PageValidators, policy?: CachePolicy): number {
    if (policy?.maxAgeMs !== undefined) return policy.maxAgeMs;
    if (!this.opts.ttlMs) return Number.POSITIVE_INFINITY;
    return Math.max(this.opts.ttlMs, entry.maxAgeMs ?? 0);
  }

  private isFresh(entry: CachedPage, policy?: CachePolicy): boolean {
    const age = Date.now() - Date.parse(entry.fetchedAt);
    return age < this.ttlFor(entry, policy);
  }

  /** Any stored entry regardless of age (memory first, then disk). Does not count as a hit. */
  getStale(url: string): CachedPage | undefined {
    if (!this.opts.enabled) return undefined;
    const key = canonicalizeUrl(url);
    const mem = this.lru.get(key);
    if (mem) return mem;
    return this.readDisk(key);
  }

  /** Fresh entry under `policy` (mode `readOnly` accepts stale entries; `bypass` never returns one). */
  get(url: string, policy?: CachePolicy): CachedPage | undefined {
    if (!this.opts.enabled || policy?.mode === 'bypass') return undefined;
    const entry = this.getStale(url);
    if (!entry) {
      this.counters.misses++;
      return undefined;
    }
    if (policy?.mode === 'readOnly' || this.isFresh(entry, policy)) {
      this.counters.hits++;
      return entry;
    }
    this.counters.stale++;
    return undefined;
  }

  /**
   * Cache-aware lookup used by `ingestUrl`: fresh hit → page; stale entry with validators →
   * conditional GET through the fetcher (304 re-stamps the entry, 200 is parsed and stored);
   * `readOnly` misses → CACHE_MISS failure. Returns undefined when the caller should fetch normally.
   */
  async lookup(
    url: string,
    ctx: {
      fetcher: Fetcher;
      parsers?: ContentParser[];
      logger?: Logger;
      signal?: AbortSignal;
      cachePolicy?: CachePolicy;
    },
  ): Promise<CacheLookup | undefined> {
    if (!this.opts.enabled) return undefined;
    const policy = ctx.cachePolicy;
    if (policy?.mode === 'bypass') return undefined;
    const fresh = this.get(url, policy);
    if (fresh) return { page: fresh, status: 'hit' };
    if (policy?.mode === 'readOnly') {
      return {
        failure: {
          url,
          code: 'CACHE_MISS',
          message: `Not in the page cache and cacheMode is "readOnly": ${url}`,
          stage: 'ingest',
        },
      };
    }
    const stale = this.getStale(url);
    if (!stale || (!stale.etag && !stale.lastModified)) return undefined;
    const headers: Record<string, string> = {};
    if (stale.etag) headers['if-none-match'] = stale.etag;
    if (stale.lastModified) headers['if-modified-since'] = stale.lastModified;
    let res: FetchedResource;
    try {
      res = await ctx.fetcher.fetch(url, ctx.signal, { headers });
    } catch (err) {
      const e = WebVectorError.from(err, { code: 'FETCH_FAILED', stage: 'ingest' });
      return { failure: { url, code: e.code, message: e.message, stage: 'ingest' } };
    }
    if (res.status === 304) {
      this.counters.notModified++;
      const page = this.restamp(url, stale, pageValidatorsFrom(res.headers));
      return { page, status: 'revalidated' };
    }
    const outcome = await parseResource(res, {
      parsers: ctx.parsers,
      cache: this,
      logger: ctx.logger,
    });
    if (outcome.ok && outcome.page) return { page: outcome.page, status: 'refetched' };
    return { failure: outcome.failure as Failure };
  }

  /** After a 304: refresh `fetchedAt` (and any new validators) in memory and on disk. */
  restamp(url: string, entry: CachedPage, validators: PageValidators = {}): CachedPage {
    const key = canonicalizeUrl(url);
    const now = Date.now();
    const page: CachedPage = {
      ...entry,
      fetchedAt: new Date(now).toISOString(),
      etag: validators.etag ?? entry.etag,
      lastModified: validators.lastModified ?? entry.lastModified,
      maxAgeMs: validators.maxAgeMs ?? entry.maxAgeMs,
    };
    const prev = this.lru.get(key);
    if (prev) this.bytes -= prev.doc.markdown.length;
    this.lru.set(key, page);
    this.bytes += page.doc.markdown.length;
    if (this.db) {
      try {
        this.db.restampPage(key, now, {
          etag: validators.etag,
          lastModified: validators.lastModified,
          maxAgeMs: validators.maxAgeMs,
        });
      } catch {
        /* ignore */
      }
    } else if (this.jsonDir) this.writeJson(key, page);
    return page;
  }

  set(url: string, page: CachedPage): void {
    if (!this.opts.enabled) return;
    const key = canonicalizeUrl(url);
    const size = page.doc.markdown.length;
    if (size > this.maxBytes) return; // never cache something bigger than the whole budget
    const prev = this.lru.get(key);
    if (prev) this.bytes -= prev.doc.markdown.length; // overwrite: LRU.set replaces without evict callback
    while (this.bytes + size > this.maxBytes && this.lru.size > 0)
      this.lru.delete(this.lru.keys()[0] as string);
    this.lru.set(key, page);
    this.bytes += size;
    this.counters.writes++;
    if (this.db) this.writeDisk(key, page);
    else if (this.jsonDir) this.writeJson(key, page);
  }

  delete(url: string): boolean {
    const key = canonicalizeUrl(url);
    const had = this.lru.delete(key);
    let disk = false;
    if (this.db) {
      try {
        disk = this.db.deletePage(key);
      } catch {
        /* ignore */
      }
    } else if (this.jsonDir) {
      try {
        rmSync(join(this.jsonDir, `${sha256(key, 32)}.json`), { force: true });
      } catch {
        /* ignore */
      }
    }
    return had || disk;
  }

  /** Clear the in-memory layer (and the on-disk layer when `disk` is true). */
  clear(disk = false): void {
    this.lru.clear();
    this.bytes = 0;
    if (disk && this.db) {
      try {
        this.db.clearPages();
      } catch {
        /* ignore */
      }
    }
  }
  get size(): number {
    return this.lru.size;
  }

  // ─── disk layer ─────────────────────────────────────────────────────────

  private readDisk(key: string): CachedPage | undefined {
    if (this.db) {
      try {
        const row = this.db.getPage(key);
        if (!row) return undefined;
        const meta = JSON.parse(row.meta) as Partial<ParsedDocument> & { parser?: string };
        const page: CachedPage = {
          doc: {
            url: row.url,
            title: row.title,
            markdown: row.markdown,
            text: meta.text ?? markdownToText(row.markdown),
            byline: meta.byline,
            siteName: meta.siteName,
            publishedAt: meta.publishedAt,
            lang: meta.lang,
            excerpt: meta.excerpt,
            contentType: row.content_type,
            parser: meta.parser ?? 'unknown',
          },
          pageHash: row.page_hash,
          fetchedAt: new Date(row.fetched_at).toISOString(),
          bytes: row.bytes,
          finalUrl: row.final_url,
          etag: row.etag ?? undefined,
          lastModified: row.last_modified ?? undefined,
          maxAgeMs: row.max_age_ms ?? undefined,
        };
        this.db.touchPage(key);
        this.counters.diskHits++;
        // Promote to memory (bounded by the memory budget).
        const size = page.doc.markdown.length;
        if (size <= this.maxBytes) {
          while (this.bytes + size > this.maxBytes && this.lru.size > 0)
            this.lru.delete(this.lru.keys()[0] as string);
          this.lru.set(key, page);
          this.bytes += size;
        }
        return page;
      } catch {
        return undefined;
      }
    }
    if (this.jsonDir) {
      const p = join(this.jsonDir, `${sha256(key, 32)}.json`);
      if (existsSync(p)) {
        try {
          const entry = JSON.parse(readFileSync(p, 'utf8')) as CachedPage;
          this.lru.set(key, entry);
          this.bytes += entry.doc.markdown.length;
          this.counters.diskHits++;
          return entry;
        } catch {
          /* ignore */
        }
      }
    }
    return undefined;
  }

  private writeDisk(key: string, page: CachedPage): void {
    if (!this.db || this.db.readOnly) return;
    try {
      const { doc } = page;
      const now = Date.now();
      const meta = JSON.stringify({
        byline: doc.byline,
        siteName: doc.siteName,
        publishedAt: doc.publishedAt,
        lang: doc.lang,
        excerpt: doc.excerpt,
        parser: doc.parser,
      });
      this.db.putPage({
        url_key: key,
        url: doc.url,
        final_url: page.finalUrl,
        fetched_at: Date.parse(page.fetchedAt) || now,
        last_access: now,
        etag: page.etag ?? null,
        last_modified: page.lastModified ?? null,
        max_age_ms: page.maxAgeMs ?? null,
        content_type: doc.contentType,
        title: doc.title,
        markdown: doc.markdown,
        bytes: page.bytes,
        md_bytes: Buffer.byteLength(doc.markdown),
        page_hash: page.pageHash,
        meta,
      });
      if (++this.writes % 32 === 0) this.db.evictPages(this.maxDiskPages, this.maxDiskBytes);
    } catch {
      /* disk problems never break a fetch */
    }
  }

  private writeJson(key: string, page: CachedPage): void {
    if (!this.jsonDir) return;
    try {
      writeFileSync(join(this.jsonDir, `${sha256(key, 32)}.json`), JSON.stringify(page));
    } catch {
      /* ignore */
    }
  }
}

export interface IngestOptions {
  fetcher: Fetcher;
  parsers?: ContentParser[];
  cache?: PageCache;
  logger?: Logger;
  signal?: AbortSignal;
  /** Per-call cache policy (maxAgeMs / mode); see `CachePolicy`. */
  cachePolicy?: CachePolicy;
}

export interface IngestOutcome {
  url: string;
  ok: boolean;
  page?: CachedPage;
  cached?: boolean;
  /** True when a stale cached copy was confirmed by a 304 Not Modified. */
  revalidated?: boolean;
  failure?: Failure;
  ms: number;
}

/** Fetch + parse one URL into a ParsedDocument (never throws; returns a failure record instead). */
export async function ingestUrl(url: string, opts: IngestOptions): Promise<IngestOutcome> {
  const t0 = Date.now();
  const hit = opts.cache ? await opts.cache.lookup(url, opts) : undefined;
  if (hit?.failure) return { url, ok: false, failure: hit.failure, ms: Date.now() - t0 };
  if (hit) {
    const cached = hit.status !== 'refetched';
    return {
      url,
      ok: true,
      page: hit.page,
      cached,
      revalidated: hit.status === 'revalidated',
      ms: cached ? 0 : Date.now() - t0,
    };
  }
  let res: FetchedResource;
  try {
    res = await opts.fetcher.fetch(url, opts.signal);
  } catch (err) {
    const e = WebVectorError.from(err, { code: 'FETCH_FAILED', stage: 'ingest' });
    return {
      url,
      ok: false,
      failure: { url, code: e.code, message: e.message, stage: 'ingest' },
      ms: Date.now() - t0,
    };
  }
  const outcome = await parseResource(res, opts);
  return { ...outcome, ms: Date.now() - t0 };
}

/** Parse an already-fetched resource. */
export async function parseResource(
  res: FetchedResource,
  opts: Pick<IngestOptions, 'parsers' | 'cache' | 'logger'>,
): Promise<Omit<IngestOutcome, 'ms'>> {
  const parsers = opts.parsers ?? createParsers();
  const parser = selectParser(parsers, res.contentType, res.finalUrl, res.bytes);
  const url = res.url;
  if (!parser) {
    return {
      url,
      ok: false,
      failure: {
        url,
        code: 'UNSUPPORTED_CONTENT_TYPE',
        message: `Unsupported content type "${res.contentType || 'unknown'}" for ${res.finalUrl}`,
        stage: 'ingest',
      },
    };
  }
  try {
    const doc = await parser.parse(res.bytes, {
      url: res.finalUrl,
      contentType: res.contentType,
      charset: res.charset,
    });
    if (!doc) {
      return {
        url,
        ok: false,
        failure: {
          url,
          code: 'PARSE_EMPTY',
          message: `No readable content extracted from ${res.finalUrl}`,
          stage: 'ingest',
        },
      };
    }
    const page: CachedPage = {
      doc: { ...doc, url: res.url },
      pageHash: sha256(doc.markdown),
      fetchedAt: new Date().toISOString(),
      bytes: res.bytes.byteLength,
      finalUrl: res.finalUrl,
      ...pageValidatorsFrom(res.headers),
    };
    opts.cache?.set(url, page);
    return { url, ok: true, page };
  } catch (err) {
    const e = WebVectorError.from(err, { code: 'PARSE_FAILED', stage: 'ingest' });
    opts.logger?.debug(`parse failed for ${res.finalUrl}: ${e.message}`);
    return {
      url,
      ok: false,
      failure: {
        url,
        code: e.code === 'ABORTED' ? 'ABORTED' : 'PARSE_FAILED',
        message: e.message,
        stage: 'ingest',
      },
    };
  }
}

/** Build a ParsedDocument from provider-supplied page content (Tavily raw_content, Exa text). */
export function documentFromProviderContent(
  url: string,
  title: string,
  content: string,
  contentType = 'text/markdown',
): CachedPage {
  const markdown = sanitizeText(content.slice(0, 2_000_000))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    doc: {
      url,
      title: cleanField(title) ?? url,
      markdown,
      text: markdownToText(markdown),
      contentType,
      parser: 'provider',
    },
    pageHash: sha256(markdown),
    fetchedAt: new Date().toISOString(),
    bytes: Buffer.byteLength(markdown),
    finalUrl: url,
  };
}

export function createFetcher(opts: FetcherOptions): Fetcher {
  return new Fetcher(opts);
}
