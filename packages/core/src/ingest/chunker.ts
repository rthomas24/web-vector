/**
 * Recursive, markdown-aware text splitter.
 *
 * - Splits on headings first, then fenced code / paragraphs / lines / sentences / words.
 * - Fenced code blocks and tables are kept atomic when they fit.
 * - Records char offsets into the source markdown for every chunk.
 * - Tracks a heading breadcrumb (`Title › H2 › H3`) prepended to the *embedded* text.
 * - Token counting: `gpt-tokenizer` (o200k) when installed, else chars/4 heuristic.
 */

export interface ChunkerOptions {
  /** Target size in tokens (default 480). */
  chunkSize?: number;
  /** Overlap in tokens (default 60). Disabled across heading boundaries. */
  chunkOverlap?: number;
  maxChunks?: number;
  /** Discard chunks shorter than this many chars (default 40). */
  minChunkChars?: number;
  /** Hard cap on characters per chunk (provider limit). */
  maxChunkChars?: number;
  /** Optional exact token counter. */
  countTokens?: (text: string) => number;
  /** Document title used as breadcrumb root. */
  title?: string;
}

export interface TextChunk {
  text: string;
  embedText: string;
  startOffset: number;
  endOffset: number;
  breadcrumb: string;
  index: number;
  tokens: number;
}

export type TokenCounter = (text: string) => number;

/** Cheap token estimate: ~4 chars/token for English prose, a bit denser for code/CJK. */
export const approxTokens: TokenCounter = (text) => {
  if (!text) return 0;
  // count CJK chars as ~1 token each
  const cjk = (text.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g) ?? []).length;
  return Math.ceil((text.length - cjk) / 4) + cjk;
};

let cachedCounter: TokenCounter | null | undefined;
/** Try to load gpt-tokenizer once; fall back to approx. */
export async function loadTokenCounter(): Promise<TokenCounter> {
  if (cachedCounter !== undefined) return cachedCounter ?? approxTokens;
  try {
    const mod: any = await import('gpt-tokenizer/encoding/o200k_base');
    const fn = mod.countTokens ?? mod.default?.countTokens;
    cachedCounter = typeof fn === 'function' ? (t: string) => fn(t) : null;
  } catch {
    cachedCounter = null;
  }
  return cachedCounter ?? approxTokens;
}

interface Segment {
  text: string;
  start: number;
  /** heading path at the start of this segment */
  crumbs: string[];
  atomic?: boolean;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Split markdown into heading-delimited sections, keeping fenced code atomic. */
function sectionize(md: string): Segment[] {
  const segs: Segment[] = [];
  const lines = md.split('\n');
  let crumbs: string[] = [];
  let buf: string[] = [];
  let bufStart = 0;
  let pos = 0;
  let inFence = false;
  let fenceBuf: string[] = [];
  let fenceStart = 0;
  const flush = () => {
    if (buf.length) {
      const text = buf.join('\n');
      if (text.trim()) segs.push({ text, start: bufStart, crumbs: [...crumbs] });
    }
    buf = [];
  };
  for (const line of lines) {
    const lineStart = pos;
    pos += line.length + 1;
    if (inFence) {
      fenceBuf.push(line);
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = false;
        segs.push({
          text: fenceBuf.join('\n'),
          start: fenceStart,
          crumbs: [...crumbs],
          atomic: true,
        });
        fenceBuf = [];
        bufStart = pos;
      }
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = true;
      fenceStart = lineStart;
      fenceBuf = [line];
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      const level = (h[1] as string).length;
      const title = (h[2] as string).replace(/[#*_`]+/g, '').trim();
      crumbs = crumbs.slice(0, Math.max(0, level - 1));
      while (crumbs.length < level - 1) crumbs.push('');
      crumbs[level - 1] = title;
      crumbs = crumbs.filter(Boolean);
      buf = [line];
      bufStart = lineStart;
      continue;
    }
    if (buf.length === 0) bufStart = lineStart;
    buf.push(line);
  }
  if (inFence && fenceBuf.length)
    segs.push({ text: fenceBuf.join('\n'), start: fenceStart, crumbs: [...crumbs], atomic: true });
  flush();
  return segs;
}

const SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' ', ''];

/** Recursively split `text` (absolute offset `base`) into pieces ≤ maxTokens. */
function recursiveSplit(
  text: string,
  base: number,
  maxTokens: number,
  count: TokenCounter,
  sepIndex = 0,
): { text: string; start: number }[] {
  if (count(text) <= maxTokens || sepIndex >= SEPARATORS.length) {
    if (count(text) <= maxTokens || sepIndex >= SEPARATORS.length - 1) {
      // last resort: hard-split by characters proportional to tokens
      if (count(text) > maxTokens) {
        const out: { text: string; start: number }[] = [];
        const approxCharsPerToken = Math.max(1, text.length / Math.max(1, count(text)));
        const size = Math.max(50, Math.floor(maxTokens * approxCharsPerToken));
        for (let i = 0; i < text.length; i += size)
          out.push({ text: text.slice(i, i + size), start: base + i });
        return out;
      }
      return [{ text, start: base }];
    }
  }
  const sep = SEPARATORS[sepIndex] as string;
  const parts: { text: string; start: number }[] = [];
  if (sep === '') {
    return recursiveSplit(text, base, maxTokens, count, sepIndex + 1);
  }
  let idx = 0;
  const pieces = text.split(sep);
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i] as string;
    const withSep = i < pieces.length - 1 ? p + sep : p;
    if (withSep.length) parts.push({ text: withSep, start: base + idx });
    idx += withSep.length;
  }
  if (parts.length <= 1) return recursiveSplit(text, base, maxTokens, count, sepIndex + 1);
  // merge pieces greedily up to maxTokens; recurse on oversize pieces
  const out: { text: string; start: number }[] = [];
  let cur: { text: string; start: number } | null = null;
  for (const part of parts) {
    if (count(part.text) > maxTokens) {
      if (cur) {
        out.push(cur);
        cur = null;
      }
      out.push(...recursiveSplit(part.text, part.start, maxTokens, count, sepIndex + 1));
      continue;
    }
    if (!cur) cur = { ...part };
    else if (count(cur.text + part.text) <= maxTokens) cur.text += part.text;
    else {
      out.push(cur);
      cur = { ...part };
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkMarkdown(markdown: string, opts: ChunkerOptions = {}): TextChunk[] {
  // Exact tokenisers can go super-linear on huge inputs / very long unbroken runs (hostile pages);
  // fall back to the estimate above a size threshold or for a giant single "word".
  const exact = opts.countTokens ?? approxTokens;
  const count: TokenCounter =
    exact === approxTokens
      ? approxTokens
      : (text) =>
          text.length > 50_000 || /\S{2000,}/.test(text) ? approxTokens(text) : exact(text);
  const maxTokens = opts.chunkSize ?? 480;
  const overlapTokens = Math.min(opts.chunkOverlap ?? 60, Math.floor(maxTokens / 3));
  const minChars = opts.minChunkChars ?? 40;
  const maxChars = opts.maxChunkChars ?? Number.POSITIVE_INFINITY;
  const title = (opts.title ?? '').trim();

  const sections = sectionize(markdown);
  const pieces: { text: string; start: number; crumbs: string[] }[] = [];
  for (const seg of sections) {
    if (seg.atomic && count(seg.text) <= maxTokens * 1.5) {
      pieces.push({ text: seg.text, start: seg.start, crumbs: seg.crumbs });
      continue;
    }
    for (const p of recursiveSplit(seg.text, seg.start, maxTokens, count))
      pieces.push({ ...p, crumbs: seg.crumbs });
  }

  // Merge small adjacent pieces (same crumbs) so we don't emit tiny fragments; add overlap.
  const merged: { text: string; start: number; end: number; crumbs: string[] }[] = [];
  for (const p of pieces) {
    const last = merged.at(-1);
    const sameCrumbs = last && last.crumbs.join('›') === p.crumbs.join('›');
    const gap = last ? p.start - last.end : -1;
    if (last && sameCrumbs && gap >= 0 && gap <= 2 && count(last.text + p.text) <= maxTokens) {
      last.text += markdown.slice(last.end, p.start) + p.text;
      last.end = p.start + p.text.length;
    } else {
      merged.push({ text: p.text, start: p.start, end: p.start + p.text.length, crumbs: p.crumbs });
    }
  }

  const chunks: TextChunk[] = [];
  let prev: { text: string; end: number; crumbs: string[] } | null = null;
  for (const m of merged) {
    let text = m.text;
    let start = m.start;
    // Overlap: prepend the tail of the previous chunk when in the same section.
    if (
      prev &&
      overlapTokens > 0 &&
      prev.crumbs.join('›') === m.crumbs.join('›') &&
      m.start - prev.end >= 0 &&
      m.start - prev.end <= 2
    ) {
      const tail = tailByTokens(prev.text, overlapTokens, count);
      if (tail && tail.length < text.length) {
        text = tail + text;
        start = m.start - tail.length;
      }
    }
    prev = { text: m.text, end: m.end, crumbs: m.crumbs };
    const trimmedLead = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (trimmed.length < minChars) continue;
    const finalText = trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
    const startOffset = start + trimmedLead;
    const crumbParts = [title, ...m.crumbs].filter(Boolean);
    // avoid duplicating heading title if the chunk begins with it
    let crumbsForPrefix = dedupeCrumbs(crumbParts);
    const breadcrumb = crumbsForPrefix.join(' › ');
    // If the chunk begins with the heading that is the last crumb, don't repeat it in the prefix.
    const firstLine = finalText
      .split('\n', 1)[0]
      ?.replace(/^#{1,6}\s+/, '')
      .trim()
      .toLowerCase();
    if (crumbsForPrefix.length && firstLine && crumbsForPrefix.at(-1)!.toLowerCase() === firstLine)
      crumbsForPrefix = crumbsForPrefix.slice(0, -1);
    const prefix = crumbsForPrefix.join(' › ');
    const embedText =
      prefix && !finalText.startsWith(prefix) ? `${prefix}\n${finalText}` : finalText;
    chunks.push({
      text: finalText,
      embedText,
      startOffset,
      endOffset: startOffset + finalText.length,
      breadcrumb,
      index: chunks.length,
      tokens: count(finalText),
    });
    if (opts.maxChunks && chunks.length >= opts.maxChunks) break;
  }
  return chunks;
}

function tailByTokens(text: string, tokens: number, count: TokenCounter): string {
  if (count(text) <= tokens) return text;
  // approximate by chars then adjust to word boundary
  const ratio = text.length / Math.max(1, count(text));
  let cut = Math.max(0, text.length - Math.floor(tokens * ratio));
  const ws = text.indexOf(' ', cut);
  if (ws > 0 && ws < text.length - 1) cut = ws + 1;
  return text.slice(cut);
}

function dedupeCrumbs(crumbs: string[]): string[] {
  const out: string[] = [];
  for (const c of crumbs) {
    const last = out.at(-1);
    if (!last || last.toLowerCase() !== c.toLowerCase()) out.push(c);
  }
  return out;
}
