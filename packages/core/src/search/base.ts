import { requireApiKey } from '../errors.js';
import { sanitizeText } from '../ingest/parsers.js';
import type { Freshness, SearchOptions, SearchResult } from '../types.js';
import {
  canonicalizeUrl,
  hostnameOf,
  looksBinary,
  matchesDomain,
  normalizeUrl,
} from '../util/url.js';

/** Common ctor options for HTTP-based search adapters. */
export interface BaseSearchOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Provider-specific pass-through options. */
  options?: Record<string, unknown>;
}

/** Strip HTML tags/entities from provider snippets. */
/** Decode a numeric entity to a printable code point, or '' for out-of-range/control/surrogate values. */
function codePoint(n: number): string {
  const printable =
    Number.isInteger(n) &&
    n >= 0x20 &&
    n <= 0x10ffff &&
    !(n >= 0x7f && n <= 0x9f) &&
    !(n >= 0xd800 && n <= 0xdfff);
  return printable ? String.fromCodePoint(n) : '';
}

/** Strip tags/entities from provider snippets, drop control characters, cap length. */
export function cleanSnippet(s: string | undefined | null, maxChars = 2000): string | undefined {
  if (!s) return undefined;
  const text = sanitizeText(
    s
      .slice(0, maxChars * 4)
      .replace(/<[^>]+>/g, '')
      .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(Number.parseInt(n, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&') // last, so "&amp;#…;" is not double-decoded
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, maxChars);
  return text || undefined;
}

/**
 * Normalise, filter and dedupe raw results from a provider:
 * - absolute http(s), fragment stripped
 * - domain allow/block lists
 * - drop obvious binaries
 * - dedupe by canonical URL keeping best rank
 */
export function normalizeResults(raw: SearchResult[], opts?: SearchOptions): SearchResult[] {
  const seen = new Map<string, SearchResult>();
  for (const r of raw) {
    const url = normalizeUrl(r.url);
    if (!url) continue;
    const host = hostnameOf(url);
    if (opts?.domainsAllow?.length && !matchesDomain(host, opts.domainsAllow)) continue;
    if (matchesDomain(host, opts?.domainsBlock)) continue;
    if (looksBinary(url)) continue;
    const key = canonicalizeUrl(url);
    const existing = seen.get(key);
    const item: SearchResult = {
      ...r,
      url,
      title: cleanSnippet(r.title, 300) ?? host,
      snippet: cleanSnippet(r.snippet),
    };
    if (!existing || existing.rank > r.rank) seen.set(key, item);
  }
  return [...seen.values()].sort((a, b) => a.rank - b.rank);
}

/** Map generic freshness to a provider-specific value using a table; returns undefined when unsupported. */
export function mapFreshness(
  f: Freshness | undefined,
  table: Partial<Record<'day' | 'week' | 'month' | 'year', string>>,
): string | undefined {
  if (!f || typeof f !== 'string') return undefined;
  return table[f];
}

export { requireApiKey };
export const KEYLESS_HINT =
  'Or use a keyless provider: `search.provider: duckduckgo` (default), `tavily-keyless`, or self-hosted `searxng`.';
