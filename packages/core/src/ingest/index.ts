import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  markdownToText,
  sanitizeText,
  selectParser,
} from './parsers.js';

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
export { RobotsCache } from './robots.js';
export { assertSafeUrl, isPublicIp } from './ssrf.js';

export interface CachedPage {
  doc: ParsedDocument;
  pageHash: string;
  fetchedAt: string;
  bytes: number;
  finalUrl: string;
}

export interface PageCacheOptions {
  enabled: boolean;
  ttlMs: number;
  maxPages: number;
  /** In-memory byte budget for cached page markdown (default 256 MB); oldest entries are evicted first. */
  maxBytes?: number;
  dir?: string;
}

/** In-process LRU + optional on-disk JSON cache keyed by canonical URL. */
export class PageCache {
  private readonly lru: LRU<string, CachedPage>;
  private bytes = 0;
  private readonly maxBytes: number;
  constructor(private readonly opts: PageCacheOptions) {
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    this.lru = new LRU(opts.maxPages, opts.ttlMs || undefined, (_k, v) => {
      this.bytes -= v.doc.markdown.length;
    });
    if (opts.dir) mkdirSync(opts.dir, { recursive: true });
  }
  get(url: string): CachedPage | undefined {
    if (!this.opts.enabled) return undefined;
    const key = canonicalizeUrl(url);
    const mem = this.lru.get(key);
    if (mem) return mem;
    if (this.opts.dir) {
      const p = join(this.opts.dir, `${sha256(key, 32)}.json`);
      if (existsSync(p)) {
        try {
          const entry = JSON.parse(readFileSync(p, 'utf8')) as CachedPage;
          if (!this.opts.ttlMs || Date.now() - Date.parse(entry.fetchedAt) < this.opts.ttlMs) {
            this.lru.set(key, entry);
            return entry;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return undefined;
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
    if (this.opts.dir) {
      try {
        writeFileSync(join(this.opts.dir, `${sha256(key, 32)}.json`), JSON.stringify(page));
      } catch {
        /* ignore */
      }
    }
  }
  clear(): void {
    this.lru.clear();
  }
  get size(): number {
    return this.lru.size;
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
}

export interface IngestOutcome {
  url: string;
  ok: boolean;
  page?: CachedPage;
  cached?: boolean;
  failure?: Failure;
  ms: number;
}

/** Fetch + parse one URL into a ParsedDocument (never throws; returns a failure record instead). */
export async function ingestUrl(url: string, opts: IngestOptions): Promise<IngestOutcome> {
  const t0 = Date.now();
  const cached = opts.cache?.get(url);
  if (cached) return { url, ok: true, page: cached, cached: true, ms: 0 };
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
    return {
      url,
      ok: false,
      failure: { url, code: e.code, message: e.message, stage: 'ingest' },
      error: e,
    };
  }
  return parseResource(res, opts);
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
