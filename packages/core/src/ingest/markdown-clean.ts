/**
 * Cleaner for *served* markdown — what a site returns when we negotiate `Accept: text/markdown`
 * (Cloudflare "Markdown for Agents", Mintlify, Vercel docs, GitBook…) or a `.md` file.
 *
 * Served markdown is not clean prose: Cloudflare keeps `[Skip to content](#…)` links and prepends
 * a "Documentation Index" blockquote; Mintlify emits raw MDX (`import`/`export const …`, JSX
 * component tags, `theme={null}` fence attributes) and an "agent instructions" block. This module
 * strips that scaffolding, lifts frontmatter into metadata and returns a ParsedDocument.
 *
 * SECURITY: the body is untrusted text like any fetched HTML. Nothing in it (including blocks
 * addressed to "agents") is ever interpreted as instructions; it is only cleaned and returned.
 */
import type { ParsedDocument } from '../types.js';
import { cleanField, decodeBytes, markdownToText, sanitizeText } from './parsers.js';

export interface CleanedMarkdown {
  markdown: string;
  /** Simple `key: value` frontmatter pairs (unquoted, first occurrence wins). */
  frontmatter: Record<string, string>;
  title?: string;
  description?: string;
  /** ISO date if the frontmatter carried a parseable one. */
  publishedAt?: string;
}

const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/;
const DATE_KEYS = [
  'date',
  'published',
  'publishedat',
  'published_at',
  'pubdate',
  'datepublished',
  'created',
  'createdat',
  'created_at',
];

/** Parse the frontmatter block into flat string pairs (nested YAML is ignored). */
export function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] as string).toLowerCase();
    let value = (m[2] as string).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (value && !(key in out)) out[key] = value;
  }
  return out;
}

/** True for a line that is (part of) a top-level MDX import/export statement. */
function isMdxImportLine(line: string): boolean {
  return /^import\s+(?:[\w*{}\s,]+\s+from\s+)?['"][^'"]+['"];?\s*$/.test(line);
}

/** JSX component tags: `<Card title="x">`, `</Card>`, `<Icon />` — capitalised (or dotted) tag names. */
const JSX_TAG_RE = /<\/?[A-Z][A-Za-z0-9.]*(?:\s[^<>]*?)?\/?>/g;
const JSX_COMMENT_RE = /^\s*\{\/\*[\s\S]*?\*\/\}\s*$/;
const SKIP_LINK_RE = /^\s*\[\s*Skip to (?:main )?content\s*\]\(#[^)]*\)\s*$/i;

/**
 * Remove MDX/JSX scaffolding from a non-code segment of markdown. Operates line-wise so multi-line
 * `export const X = (…) => {…};` blocks and multi-line component tags are removed as units.
 */
function stripMdx(segment: string): string {
  const lines = segment.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (isMdxImportLine(line)) continue;
    if (JSX_COMMENT_RE.test(line)) continue;
    if (SKIP_LINK_RE.test(line)) continue;
    // export const/function/default … — consume until brackets balance and the statement ends.
    if (/^export\s+(?:const|let|var|function|default|async)\b/.test(line)) {
      let depth = 0;
      let j = i;
      for (; j < lines.length && j < i + 200; j++) {
        const l = lines[j] as string;
        for (const ch of l) {
          if (ch === '{' || ch === '(' || ch === '[') depth++;
          else if (ch === '}' || ch === ')' || ch === ']') depth--;
        }
        if (depth <= 0 && (j === i || /[;})]\s*$/.test(l) || l.trim() === '')) break;
      }
      i = j;
      continue;
    }
    // Multi-line component tag: `<Card` … `>` (no `>` on the opening line).
    if (/^\s*<[A-Z][A-Za-z0-9.]*(?:\s|$)/.test(line) && !line.includes('>')) {
      let j = i;
      while (j < lines.length && j < i + 40 && !(lines[j] as string).includes('>')) j++;
      const rest = (lines[j] ?? '').replace(/^[^>]*>/, '');
      i = j;
      if (rest.trim()) out.push(rest);
      continue;
    }
    const stripped = line.replace(JSX_TAG_RE, '');
    if (stripped.trim() === '' && line.trim() !== '') continue; // line was only tags
    out.push(stripped);
  }
  return out.join('\n');
}

/** Drop a leading "Documentation Index" blockquote (Cloudflare/Mintlify boilerplate). */
function stripDocIndexBlock(md: string): string {
  const m = /^(?:>[^\n]*\n?)+/.exec(md);
  if (m && /documentation index/i.test(m[0].split('\n')[0] ?? '')) return md.slice(m[0].length);
  return md;
}

/** Clean served markdown / MDX into plain markdown; frontmatter is parsed out. */
export function cleanServedMarkdown(raw: string): CleanedMarkdown {
  let text = raw.replace(/\r\n?/g, '\n');
  let frontmatter: Record<string, string> = {};
  const fm = FRONTMATTER_RE.exec(text);
  if (fm) {
    frontmatter = parseFrontmatter(fm[1] as string);
    text = text.slice(fm[0].length);
  }
  // Process only non-code segments (fence-aware split on ``` lines).
  const parts = text.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m);
  const cleaned = parts
    .map((part, i) => {
      if (i % 2 === 1) return part.replace(/^(```[\w+#.-]*)[^\n]*$/m, '$1'); // drop fence attrs (theme={null}, title="…")
      return stripMdx(part);
    })
    .join('');
  let markdown = stripDocIndexBlock(cleaned.replace(/^\s+/, ''));
  markdown = sanitizeText(markdown)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const dateKey = DATE_KEYS.find((k) => frontmatter[k]);
  let publishedAt: string | undefined;
  if (dateKey) {
    const d = Date.parse(frontmatter[dateKey] as string);
    publishedAt = Number.isFinite(d) ? new Date(d).toISOString() : undefined;
  }
  return {
    markdown,
    frontmatter,
    title: cleanField(frontmatter.title),
    description: cleanField(frontmatter.description, 500),
    publishedAt,
  };
}

export interface ServedMarkdownContext {
  url: string;
  charset?: string;
  /** Response headers: `x-markdown-tokens` and `content-signal` are recorded into metadata. */
  headers?: Headers;
  /** Minimum cleaned length to count as content (default 40). */
  minChars?: number;
}

/** True when a response should be treated as served markdown rather than generic text. */
export function isServedMarkdown(contentType: string, url: string): boolean {
  if (/^text\/(x-)?markdown\b/.test(contentType)) return true;
  if (contentType === 'text/plain' || contentType === '') {
    try {
      return /\.(md|mdx|markdown)$/i.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }
  return false;
}

/** Parse served markdown into a ParsedDocument (`parser: 'server-markdown'`); null when empty. */
export function parseServedMarkdown(
  bytes: Uint8Array,
  ctx: ServedMarkdownContext,
): ParsedDocument | null {
  const cleaned = cleanServedMarkdown(decodeBytes(bytes, ctx.charset));
  if (cleaned.markdown.length < (ctx.minChars ?? 40)) return null;
  const heading = cleaned.markdown
    .split('\n')
    .slice(0, 30)
    .find((l) => /^#\s+\S/.test(l))
    ?.replace(/^#+\s*/, '')
    .trim();
  const title = cleaned.title ?? cleanField(heading) ?? hostTitle(ctx.url);
  const metadata: Record<string, string | number | boolean> = {};
  const tokens = Number(ctx.headers?.get('x-markdown-tokens'));
  if (Number.isFinite(tokens) && tokens > 0) metadata.markdownTokens = tokens;
  const signal = ctx.headers?.get('content-signal');
  if (signal) metadata.contentSignal = signal.slice(0, 200);
  for (const [k, v] of Object.entries(cleaned.frontmatter)) {
    if (k === 'title' || k === 'description') continue;
    if (Object.keys(metadata).length >= 24) break;
    metadata[`frontmatter.${k}`] = v.slice(0, 300);
  }
  return {
    url: ctx.url,
    title: title.slice(0, 300),
    markdown: cleaned.markdown,
    text: markdownToText(cleaned.markdown),
    excerpt: cleaned.description,
    publishedAt: cleaned.publishedAt,
    contentType: 'text/markdown',
    parser: 'server-markdown',
    metadata,
  };
}

function hostTitle(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
