/**
 * Shared executor for the `webvector_fetch` tool (no `query`): fetch → Markdown → paginate on a
 * paragraph boundary with an explicit continuation sentence, optional link list, token accounting.
 * Used by the MCP server and every adapter so the wire format is identical.
 */
import { approxTokens } from '../ingest/chunker.js';
import { type PageLink, slicePage } from './fetch-options.js';
import type { WebFetchInput } from './tool.js';
import type { WebVector } from './webvector.js';

export const DEFAULT_FETCH_MAX_LENGTH = 20_000;

export interface FetchToolStructured {
  url: string;
  title: string;
  contentType: string;
  parser: string;
  publishedAt?: string;
  siteName?: string;
  lang?: string;
  /** Characters in the whole page Markdown. */
  totalChars: number;
  /** Characters returned in this call. */
  chars: number;
  approxTokens: number;
  truncated: boolean;
  startIndex: number;
  /** Pass as `start_index` to continue; absent when the page is complete. */
  nextStartIndex?: number;
  links?: PageLink[];
  warnings?: string[];
}

export interface FetchToolOutput {
  text: string;
  structured: FetchToolStructured;
}

export function continuationSentence(
  end: number,
  total: number,
  fetchToolName = 'webvector_fetch',
): string {
  return `_Content truncated at char ${end} of ${total}. Call ${fetchToolName} with start_index=${end} to continue, or pass \`query\` to get only relevant passages._`;
}

/** Fetch a page as Markdown with pagination + optional links. Throws WebVectorError on failure. */
export async function runFetchTool(
  wv: WebVector,
  input: WebFetchInput,
  opts: { signal?: AbortSignal; defaultMaxLength?: number; fetchToolName?: string } = {},
): Promise<FetchToolOutput> {
  const maxLength =
    input.max_length ?? input.max_chars ?? opts.defaultMaxLength ?? DEFAULT_FETCH_MAX_LENGTH;
  const start = input.start_index ?? 0;
  const doc = await wv.fetch(input.url, {
    signal: opts.signal,
    selector: input.selector,
    excludeSelectors: input.exclude_selectors,
    includeLinks: input.include_links,
  });
  const warnings: string[] = [];
  if (input.selector && doc.parser !== 'selector')
    warnings.push(
      `selector "${input.selector}" matched nothing; returned the auto-detected main content instead.`,
    );
  const slice = slicePage(doc.markdown, start, maxLength);
  const parts: string[] = [`# ${doc.title}\n<${doc.url}>`];
  if (warnings.length) parts.push(warnings.map((w) => `_${w}_`).join('\n'));
  if (slice.start > 0 && slice.text)
    parts.push(`_(continuing from char ${slice.start} of ${slice.totalChars})_`);
  if (slice.text) parts.push(slice.text.trim());
  else if (slice.start >= slice.totalChars)
    parts.push(
      `_start_index ${start} is past the end of the content (${slice.totalChars} chars)._`,
    );
  if (slice.truncated)
    parts.push(continuationSentence(slice.end, slice.totalChars, opts.fetchToolName));
  if (doc.links) {
    const shown = doc.links.map((l) => `- ${l.text ? `${l.text} — ` : ''}<${l.url}>`);
    parts.push(`## Links (${doc.links.length})\n${shown.join('\n') || '- (none)'}`);
  }
  const text = parts.join('\n\n');
  const structured: FetchToolStructured = {
    url: doc.url,
    title: doc.title,
    contentType: doc.contentType,
    parser: doc.parser,
    ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
    ...(doc.siteName ? { siteName: doc.siteName } : {}),
    ...(doc.lang ? { lang: doc.lang } : {}),
    totalChars: slice.totalChars,
    chars: slice.text.length,
    approxTokens: approxTokens(text),
    truncated: slice.truncated,
    startIndex: slice.start,
    ...(slice.truncated ? { nextStartIndex: slice.end } : {}),
    ...(doc.links ? { links: doc.links } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
  return { text, structured };
}
