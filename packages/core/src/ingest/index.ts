import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CacheDb, openCacheDb, resolveCacheDir } from '../cache/db.js';
import { WebVectorError } from '../errors.js';
import type { ContentParser, Failure, Logger, ParsedDocument } from '../types.js';
import { sha256 } from '../util/hash.js';
import { LRU } from '../util/lru.js';
import { canonicalizeUrl, cleanUrl } from '../util/url.js';
import { selectFastPath } from './fast-paths.js';
import { type FetchedResource, Fetcher, type FetcherOptions } from './fetcher.js';
import { isServedMarkdown, parseServedMarkdown } from './markdown-clean.js';
import {
  cleanField,
  createParsers,
  HtmlParser,
  markdownToText,
  sanitizeText,
  selectParser,
  TextParser,
} from './parsers.js';
import { isBlockedFailure, type RenderHook, renderWithHook } from './render.js';

export type { ChunkerOptions, TextChunk, TokenCounter } from './chunker.js';
export { approxTokens, chunkMarkdown, loadTokenCounter } from './chunker.js';
export type { FastPath, FastPathContext } from './fast-paths.js';
export {
  builtinFastPaths,
  cooldownFastPath,
  listFastPaths,
  registerFastPath,
  selectFastPath,
} from './fast-paths.js';
export type { FetchedResource, FetcherOptions, FetchInit } from './fetcher.js';
export { acceptHeaderFor, Fetcher, parseContentType } from './fetcher.js';
export type { CleanedMarkdown, ServedMarkdownContext } from './markdown-clean.js';
export {
  cleanServedMarkdown,
  isServedMarkdown,
  parseFrontmatter,
  parseServedMarkdown,
} from './markdown-clean.js';
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
export type {
  RenderConfig,
  RenderHook,
  RenderProvider,
  RenderResult,
  RenderWhen,
} from './render.js';
export {
  BrowserlessRenderProvider,
  CloudflareRenderProvider,
  createRenderProvider,
  RenderBudget,
} from './render.js';
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
  /** URL-rewrite / API fast paths (`ingestion.fastPaths`): true (default), false, or a list of ids. */
  fastPaths?: boolean | string[];
  /** Environment for optional fast-path API keys (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /**
   * Wayback Machine fallback (`ingestion.archiveFallback`): `'blocked'` retries bot-walled /
   * paywalled / 404-410 / needs-JS pages from web.archive.org, `'always'` any fetch failure except
   * robots/SSRF/content-signal refusals; `false` (default) never.
   */
  archiveFallback?: false | 'blocked' | 'always';
  /** Per-call cache policy (maxAgeMs / mode); see `CachePolicy`. */
  cachePolicy?: CachePolicy;
  /** Optional renderer, tried when the page is a JS shell (or blocked, per `hook.when`). */
  render?: RenderHook;
}

export interface IngestOutcome {
  url: string;
  ok: boolean;
  page?: CachedPage;
  cached?: boolean;
  /** True when a stale cached copy was confirmed by a 304 Not Modified. */
  revalidated?: boolean;
  /** True when this call joined an identical in-flight fetch (single-flight coalescing). */
  coalesced?: boolean;
  failure?: Failure;
  ms: number;
  /** True when the page came from the render hook rather than the plain fetch. */
  rendered?: boolean;
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
  const first = await fetchAndParse(url, opts);
  if (first.ok || !opts.archiveFallback) return { ...first, ms: Date.now() - t0 };
  if (archiveEligible(first, opts.archiveFallback)) {
    const archived = await ingestFromArchive(url, opts);
    if (archived?.ok) return { ...archived, ms: Date.now() - t0 };
  }
  return { ...first, ms: Date.now() - t0 };
}

async function fetchAndParse(
  url: string,
  opts: IngestOptions,
): Promise<Omit<IngestOutcome, 'ms'> & { error?: WebVectorError }> {
  let res: FetchedResource | undefined;
  // Fast path (arXiv HTML, GitHub raw, HN/SO/GitHub-issue APIs…): try once, fall back on any failure.
  const fp = selectFastPath(cleanUrl(url).url, opts.fastPaths ?? true);
  if (fp) {
    try {
      const r = await fp.resolve({
        url: new URL(cleanUrl(url).url),
        fetch: (u, init) => opts.fetcher.fetch(u, opts.signal, init),
        signal: opts.signal,
        env: opts.env ?? process.env,
        logger: opts.logger,
      });
      if (r) res = r;
      else opts.logger?.debug(`fast path ${fp.id}: no result for ${url}; fetching normally`);
    } catch (err) {
      if (WebVectorError.is(err, 'ABORTED')) throw err;
      opts.logger?.debug(
        `fast path ${fp.id} failed for ${url} (${err instanceof Error ? err.message : err}); fetching normally`,
      );
    }
  }
  try {
    res ??= await opts.fetcher.fetch(url, opts.signal);
  } catch (err) {
    const e = WebVectorError.from(err, { code: 'FETCH_FAILED', stage: 'ingest' });
    const failure: Failure = { url, code: e.code, message: e.message, stage: 'ingest' };
    const status = (e.details as { status?: number } | undefined)?.status;
    if (opts.render?.when === 'blocked' && isBlockedFailure(e.code, status)) {
      const rendered = await renderUrl(url, opts, failure);
      if (rendered) return rendered;
    }
    return { url, ok: false, failure, error: e };
  }
  const outcome = await parseResource(res, opts);
  if (
    !outcome.ok &&
    outcome.failure?.code === 'PARSE_NEEDS_JS' &&
    opts.render &&
    opts.render.when !== 'never'
  ) {
    const rendered = await renderUrl(url, opts, outcome.failure);
    if (rendered) return rendered;
  }
  return outcome;
}

// ─── Wayback Machine fallback (opt-in) ───────────────────────────────────────

const ARCHIVE_NEVER = new Set([
  'ABORTED',
  'FETCH_BLOCKED_ROBOTS',
  'FETCH_BLOCKED_SSRF',
  'FETCH_BLOCKED_CONTENT_SIGNAL',
]);
const ARCHIVE_BLOCKED = new Set(['FETCH_BLOCKED_BOT', 'FETCH_PAYMENT_REQUIRED', 'PARSE_NEEDS_JS']);
/** Wayback etiquette: ≈1 request/s process-wide; a 429 switches the fallback off for a while. */
const ARCHIVE_MIN_INTERVAL_MS = 1000;
const ARCHIVE_DISABLE_MS = 10 * 60_000;
const archiveState = { nextSlot: 0, disabledUntil: 0 };

/** Test hook: clear the archive limiter / disable state. */
export function resetArchiveFallbackState(): void {
  archiveState.nextSlot = 0;
  archiveState.disabledUntil = 0;
}

function archiveEligible(
  outcome: { failure?: Failure; error?: WebVectorError },
  mode: 'blocked' | 'always',
): boolean {
  const code = outcome.failure?.code ?? '';
  if (ARCHIVE_NEVER.has(code)) return false;
  if (mode === 'always') return true;
  if (ARCHIVE_BLOCKED.has(code)) return true;
  const status = (outcome.error?.details as { status?: number } | undefined)?.status;
  return code === 'FETCH_HTTP_ERROR' && (status === 404 || status === 410);
}

async function archiveSlot(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, archiveState.nextSlot - now);
  archiveState.nextSlot = Math.max(now, archiveState.nextSlot) + ARCHIVE_MIN_INTERVAL_MS;
  if (wait > 0)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, wait);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new WebVectorError('Ingest aborted', { code: 'ABORTED', stage: 'ingest' }));
        },
        { once: true },
      );
    });
}

interface WaybackAvailable {
  archived_snapshots?: { closest?: { available?: boolean; status?: string; timestamp?: string } };
}

/** Wayback timestamp (YYYYMMDDhhmmss) → ISO. */
function waybackIso(ts: string): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(ts);
  if (!m) return undefined;
  const d = new Date(
    Date.UTC(
      +(m[1] as string),
      +(m[2] as string) - 1,
      +(m[3] as string),
      +(m[4] ?? 0),
      +(m[5] ?? 0),
      +(m[6] ?? 0),
    ),
  );
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/**
 * Look the URL up in the Wayback availability API (archive.org/wayback/available?url=…) and fetch
 * the raw snapshot (web.archive.org/web/{ts}id_/{url}) through the normal guarded fetcher.
 * Never used for pages that declare `isAccessibleForFree: false` (paywall). Returns undefined
 * when there is no usable snapshot.
 */
async function ingestFromArchive(
  url: string,
  opts: IngestOptions,
): Promise<Omit<IngestOutcome, 'ms'> | undefined> {
  if (Date.now() < archiveState.disabledUntil) return undefined;
  const log = (m: string) => opts.logger?.debug(`archive fallback: ${m}`);
  const rateLimited = (err: unknown) => {
    if (WebVectorError.is(err, 'PROVIDER_RATE_LIMITED')) {
      archiveState.disabledUntil = Date.now() + ARCHIVE_DISABLE_MS;
      log(`429 from archive.org — disabled for ${ARCHIVE_DISABLE_MS / 60_000} min`);
    }
  };
  let ts: string | undefined;
  try {
    await archiveSlot(opts.signal);
    const avail = await opts.fetcher.fetch(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
      opts.signal,
      { retries: 0 },
    );
    const closest = (JSON.parse(new TextDecoder().decode(avail.bytes)) as WaybackAvailable)
      .archived_snapshots?.closest;
    if (closest?.available && /^2\d\d$/.test(closest.status ?? '') && closest.timestamp)
      ts = closest.timestamp;
  } catch (err) {
    if (WebVectorError.is(err, 'ABORTED')) throw err;
    rateLimited(err);
    log(`availability lookup failed for ${url} (${err instanceof Error ? err.message : err})`);
    return undefined;
  }
  if (!ts) {
    log(`no snapshot for ${url}`);
    return undefined;
  }
  const archiveUrl = `https://web.archive.org/web/${ts}id_/${url}`;
  let res: FetchedResource;
  try {
    await archiveSlot(opts.signal);
    res = await opts.fetcher.fetch(archiveUrl, opts.signal, { retries: 0 });
  } catch (err) {
    if (WebVectorError.is(err, 'ABORTED')) throw err;
    rateLimited(err);
    log(`snapshot fetch failed for ${archiveUrl} (${err instanceof Error ? err.message : err})`);
    return undefined;
  }
  // Paywall guard: never serve archived copies of pages that declare themselves not free.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(res.bytes.subarray(0, 512 * 1024));
  if (/["']isAccessibleForFree["']\s*:\s*(?:false|["']false["'])/i.test(head)) {
    log(`snapshot of ${url} declares isAccessibleForFree:false — not used`);
    return undefined;
  }
  const outcome = await parseResource(
    { ...res, url, finalUrl: archiveUrl },
    { ...opts, cache: undefined },
  );
  if (!outcome.ok || !outcome.page) return undefined;
  const archivedAt = waybackIso(ts);
  const page: CachedPage = {
    ...outcome.page,
    doc: {
      ...outcome.page.doc,
      fetchedFrom: 'archive',
      archivedAt,
      metadata: { ...outcome.page.doc.metadata, archiveUrl },
    },
  };
  opts.cache?.set(url, page);
  log(`served ${url} from ${archiveUrl}`);
  return { ...outcome, page };
}

/**
 * Render a JS shell / blocked page through the configured hook and parse the result. Returns
 * undefined (leaving the original failure in place) when the render is skipped or fails; the
 * failure message then notes why.
 */
async function renderUrl(
  url: string,
  opts: IngestOptions,
  original: Failure,
): Promise<Omit<IngestOutcome, 'ms'> | undefined> {
  const hook = opts.render as RenderHook;
  try {
    const r = await renderWithHook(hook, url, opts.signal);
    const finalUrl = r.finalUrl ?? url;
    let doc: ParsedDocument | null = null;
    if (r.html) {
      const parsers = opts.parsers ?? createParsers();
      const html =
        (parsers.find((p) => p.id === 'html') as HtmlParser | undefined) ?? new HtmlParser();
      doc = await html.parseHtml(r.html, finalUrl);
    } else if (r.markdown) {
      doc = await new TextParser().parse(new TextEncoder().encode(r.markdown), {
        url: finalUrl,
        contentType: 'text/markdown',
      });
    }
    if (!doc) {
      original.message += ` Rendering with ${hook.provider.id} produced no readable content either.`;
      return undefined;
    }
    doc = { ...doc, url, parser: `render:${hook.provider.id}/${doc.parser}` };
    const page: CachedPage = {
      doc,
      pageHash: sha256(doc.markdown),
      fetchedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(r.html ?? r.markdown ?? ''),
      finalUrl,
    };
    opts.cache?.set(url, page);
    return { url, ok: true, page, rendered: true };
  } catch (err) {
    const e = WebVectorError.from(err, { code: 'PARSE_FAILED', stage: 'ingest' });
    opts.logger?.debug(`render failed for ${url}: ${e.message}`);
    original.message += ` Rendering with ${hook.provider.id} failed: ${e.message}`;
    return undefined;
  }
}

/** Parse an already-fetched resource. */
export async function parseResource(
  res: FetchedResource,
  opts: Pick<IngestOptions, 'parsers' | 'cache' | 'logger'>,
): Promise<Omit<IngestOutcome, 'ms'>> {
  const parsers = opts.parsers ?? createParsers();
  const url = res.url;
  // Served markdown (negotiated `text/markdown` or a .md file): skip Readability, run the cleaner.
  const served = isServedMarkdown(res.contentType, res.finalUrl);
  const parser = served
    ? undefined
    : selectParser(parsers, res.contentType, res.finalUrl, res.bytes);
  if (!parser && !served) {
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
    const doc = served
      ? parseServedMarkdown(res.bytes, {
          url: res.finalUrl,
          charset: res.charset,
          headers: res.headers,
        })
      : await (parser as ContentParser).parse(res.bytes, {
          url: res.finalUrl,
          contentType: res.contentType,
          charset: res.charset,
          contentLanguage: res.headers?.get?.('content-language') ?? undefined,
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
    if (res.contentSignal && !doc.contentSignal) doc.contentSignal = res.contentSignal;
    if (res.textFragment && !doc.textFragment) doc.textFragment = res.textFragment;
    if (res.fastPath) {
      doc.metadata = { ...doc.metadata, fastPath: res.fastPath.id };
      if (res.fastPath.api) doc.fetchedFrom = 'api';
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
        code: e.code === 'ABORTED' || e.code === 'PARSE_NEEDS_JS' ? e.code : 'PARSE_FAILED',
        message: e.remediation ? `${e.message} ${e.remediation}` : e.message,
        stage: 'ingest',
      },
    };
  }
}

// ─── Provider-supplied content (Tavily raw_content, Exa text) ────────────────

export interface ProviderContentAssessment {
  ok: boolean;
  /** Why the content was rejected (`short` | `html` | `truncated` | `boilerplate`). */
  reason?: 'short' | 'html' | 'truncated' | 'boilerplate';
  chars: number;
}

/**
 * Quality gate for provider-returned page text before trusting it instead of fetching:
 * long enough (`minChars`, default 300), not raw HTML, not cut off at a round provider cap
 * (…1000/2000/4000/8000 chars mid-sentence, or a trailing ellipsis), not mostly links/nav lines.
 */
export function assessProviderContent(
  content: string,
  opts: { minChars?: number } = {},
): ProviderContentAssessment {
  const text = content.replace(/\r\n?/g, '\n').trim();
  const chars = text.length;
  const minChars = opts.minChars ?? 300;
  if (chars < minChars) return { ok: false, reason: 'short', chars };
  // Raw HTML rather than text/markdown.
  const tags = (
    text.match(/<\/?(?:html|body|div|p|span|a|li|ul|script|style|br|h[1-6]|table|td)\b[^>]*>/gi) ??
    []
  ).length;
  if (/^\s*<(?:!doctype|html|body)/i.test(text) || tags >= 8)
    return { ok: false, reason: 'html', chars };
  // Truncated at a round cap: exact multiple of 500 chars (1000, 2000, 4000, 8000…) or a trailing
  // ellipsis, and the text does not end at a sentence/block boundary.
  const tail = text.slice(-1);
  const endsClean =
    /[.!?)\]"'”’`>*_|-]$/.test(tail) || /```\s*$/.test(text) || /\n\s*$/.test(content);
  const rawChars = content.length;
  const roundCap = chars >= 900 && (chars % 500 === 0 || rawChars % 500 === 0);
  const ellipsis = /(?:\.\.\.|…)$/.test(text) && chars >= 900;
  if ((roundCap && !endsClean) || ellipsis) return { ok: false, reason: 'truncated', chars };
  // Boilerplate: mostly links, or a wall of short nav-like lines.
  const lines = text.split('\n').filter((l) => l.trim());
  const linkChars = (text.match(/\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g) ?? []).reduce(
    (n, m) => n + m.length,
    0,
  );
  if (linkChars / chars > 0.5) return { ok: false, reason: 'boilerplate', chars };
  if (lines.length >= 12 && lines.filter((l) => l.trim().length < 40).length / lines.length > 0.8)
    return { ok: false, reason: 'boilerplate', chars };
  return { ok: true, chars };
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
      fetchedFrom: 'provider',
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
