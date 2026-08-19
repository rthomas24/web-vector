import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebVectorError } from '../errors.js';
import type { ContentParser, Failure, Logger, ParsedDocument } from '../types.js';
import { sha256 } from '../util/hash.js';
import { LRU } from '../util/lru.js';
import { canonicalizeUrl } from '../util/url.js';
import { type FetchedResource, Fetcher, type FetcherOptions } from './fetcher.js';
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
  /** Optional renderer, tried when the page is a JS shell (or blocked, per `hook.when`). */
  render?: RenderHook;
}

export interface IngestOutcome {
  url: string;
  ok: boolean;
  page?: CachedPage;
  cached?: boolean;
  failure?: Failure;
  ms: number;
  /** True when the page came from the render hook rather than the plain fetch. */
  rendered?: boolean;
}

/** Fetch + parse one URL into a ParsedDocument (never throws; returns a failure record instead). */
export async function ingestUrl(url: string, opts: IngestOptions): Promise<IngestOutcome> {
  const t0 = Date.now();
  const cached = opts.cache?.get(url);
  if (cached) return { url, ok: true, page: cached, cached: true, ms: 0 };
  let res: FetchedResource;
  try {
    res = await opts.fetcher.fetch(url, opts.signal);
  } catch (err) {
    const e = WebVectorError.from(err, { code: 'FETCH_FAILED', stage: 'ingest' });
    const failure: Failure = { url, code: e.code, message: e.message, stage: 'ingest' };
    const status = (e.details as { status?: number } | undefined)?.status;
    if (opts.render?.when === 'blocked' && isBlockedFailure(e.code, status)) {
      const rendered = await renderUrl(url, opts, failure);
      if (rendered) return { ...rendered, ms: Date.now() - t0 };
    }
    return { url, ok: false, failure, ms: Date.now() - t0 };
  }
  const outcome = await parseResource(res, opts);
  if (
    !outcome.ok &&
    outcome.failure?.code === 'PARSE_NEEDS_JS' &&
    opts.render &&
    opts.render.when !== 'never'
  ) {
    const rendered = await renderUrl(url, opts, outcome.failure);
    if (rendered) return { ...rendered, ms: Date.now() - t0 };
  }
  return { ...outcome, ms: Date.now() - t0 };
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
        code: e.code === 'ABORTED' || e.code === 'PARSE_NEEDS_JS' ? e.code : 'PARSE_FAILED',
        message: e.remediation ? `${e.message} ${e.remediation}` : e.message,
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
