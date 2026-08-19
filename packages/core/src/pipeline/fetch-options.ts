/**
 * Helpers for the extended `WebVector.fetch()` options that operate on the raw HTML string:
 * CSS `selector` / `excludeSelectors` (linkedom) and link extraction. Kept out of the parser stack
 * (ingest/parsers.ts) on purpose: the parsers stay Readability/mdream-based, and these helpers
 * pre-filter the DOM or convert a chosen subtree directly.
 */
import { parseHTML } from 'linkedom';
import { htmlToMarkdown } from 'mdream';
import { markdownToText } from '../ingest/parsers.js';
import type { CacheMode, ParsedDocument } from '../types.js';
import { hostnameOf } from '../util/url.js';

export interface PageLink {
  url: string;
  text: string;
}

export interface FetchOptions {
  signal?: AbortSignal;
  /** `false` disables the page cache for this call entirely (no read, no write). */
  useCache?: boolean;
  /** Accept cached pages at most this old (ms); see `ResearchOptions.maxAgeMs`. */
  maxAgeMs?: number;
  /** `default` (cache, revalidate when stale) · `bypass` · `readOnly` (never touch the network). */
  cacheMode?: CacheMode;
  /**
   * CSS selector: convert only the matching element(s) to Markdown (bypasses Readability's
   * main-content heuristics). Ignored for non-HTML resources.
   */
  selector?: string;
  /** CSS selectors to remove before extraction (cookie banners, nav, "was this helpful"). */
  excludeSelectors?: string[];
  /** Also return the page's links (deduped, same-host first, capped). */
  includeLinks?: boolean;
  /** Cap for `includeLinks` (default 150). */
  maxLinks?: number;
}

export interface FetchedDocument extends ParsedDocument {
  /** Present when `includeLinks` was requested. */
  links?: PageLink[];
}

const NAV_STRIP = 'script,style,noscript,template,svg,iframe';

/** Remove nodes matching `excludeSelectors` from an HTML string. Returns the remaining HTML. */
export function excludeFromHtml(html: string, excludeSelectors: string[]): string {
  if (!excludeSelectors.length) return html;
  const { document } = parseHTML(html);
  for (const sel of excludeSelectors) {
    try {
      for (const el of [...document.querySelectorAll(sel)]) el.remove();
    } catch {
      /* invalid selector — ignore */
    }
  }
  return document.documentElement?.outerHTML ?? html;
}

/**
 * Convert only the subtree(s) matching `selector` to Markdown. Returns null when nothing matches
 * (callers fall back to the regular parser and add a warning).
 */
export function selectFromHtml(
  html: string,
  url: string,
  selector: string,
  opts: { excludeSelectors?: string[]; contentType?: string } = {},
): ParsedDocument | null {
  const { document } = parseHTML(html);
  const title = (document.title || '').trim() || hostnameOf(url);
  for (const sel of opts.excludeSelectors ?? []) {
    try {
      for (const el of [...document.querySelectorAll(sel)]) el.remove();
    } catch {
      /* ignore */
    }
  }
  let matches: Element[];
  try {
    matches = [...document.querySelectorAll(selector)] as unknown as Element[];
  } catch {
    return null;
  }
  if (matches.length === 0) return null;
  for (const m of matches) for (const el of [...m.querySelectorAll(NAV_STRIP)]) el.remove();
  const subtree = matches.map((m) => m.outerHTML).join('\n');
  const markdown = htmlToMarkdown(subtree, { origin: url })
    .replace(/^---\n[\s\S]*?\n---(?:\n+|$)/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!markdown) return null;
  return {
    url,
    title,
    markdown,
    text: markdownToText(markdown),
    contentType: opts.contentType ?? 'text/html',
    parser: 'selector',
  };
}

/** Deduped absolute http(s) links from an HTML string, same-host first, capped. */
export function extractLinks(html: string, baseUrl: string, max = 150): PageLink[] {
  const { document } = parseHTML(html);
  const host = hostnameOf(baseUrl);
  const seen = new Set<string>();
  const same: PageLink[] = [];
  const other: PageLink[] = [];
  for (const a of [...document.querySelectorAll('a[href]')]) {
    const href = (a.getAttribute('href') ?? '').trim();
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) continue;
    let abs: URL;
    try {
      abs = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    abs.hash = '';
    const key = abs.href;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    (abs.hostname === host ? same : other).push({ url: key, text });
    if (same.length + other.length >= max * 4) break; // bound work on huge pages
  }
  return [...same, ...other].slice(0, max);
}

export interface SliceResult {
  text: string;
  /** Char index of the first character of `text` in the full content. */
  start: number;
  /** Char index just past the last character returned (pass as `start_index` to continue). */
  end: number;
  totalChars: number;
  truncated: boolean;
}

/**
 * Slice `content` for pagination: from `start` up to `maxLength` chars, cutting on a paragraph
 * or heading boundary when one is reasonably close (≥ 60 % of the window).
 */
export function slicePage(content: string, start: number, maxLength: number): SliceResult {
  const totalChars = content.length;
  const from = Math.max(0, Math.min(start, totalChars));
  if (from >= totalChars)
    return { text: '', start: from, end: totalChars, totalChars, truncated: false };
  let end = Math.min(totalChars, from + maxLength);
  if (end < totalChars) {
    const window = content.slice(from, end);
    const minCut = Math.floor(maxLength * 0.6);
    // Prefer a heading boundary, then a blank line, then a newline.
    const candidates = [
      window.lastIndexOf('\n#'),
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
    ];
    for (const c of candidates) {
      if (c >= minCut) {
        end = from + c + 1;
        break;
      }
    }
  }
  return {
    text: content.slice(from, end),
    start: from,
    end,
    totalChars,
    truncated: end < totalChars,
  };
}
