/**
 * Query-focused highlights: the 1–3 sentence window of a passage that best answers the query.
 *
 * Passages are chunk-sized (~500 tokens); the sentence or two that actually carries the answer is
 * usually a fraction of that. We split a passage into segments (sentences of prose; fenced code
 * blocks, tables and other single lines stay atomic so we never cut inside them), then pick the
 * window of up to `maxSegments` consecutive segments with the best idf-weighted query-term
 * coverage. No model is needed; the retrieve stage blends in a cosine score when an embedder exists.
 */
import { tokenize } from './bm25.js';

export interface Highlight {
  text: string;
  /** Char offsets into the page markdown (passage offset + local position). */
  startOffset: number;
  endOffset: number;
}

export interface Segment {
  text: string;
  /** Local char offsets into the passage text. */
  start: number;
  end: number;
  /**
   * `block` = fenced code / table (never split, never bridged across); `line` = heading, list item
   * or blockquote line (kept whole, may join a window); `sentence` = prose sentence.
   */
  kind: 'sentence' | 'line' | 'block';
}

/** Abbreviations that end with a period but do not end a sentence. */
const ABBREV_RE = /\b(?:e\.g|i\.e|etc|vs|cf|Dr|Mr|Mrs|Ms|St|No|Fig|approx|al)\.$/i;
/** Sentence boundary: terminal punctuation (optionally a closing quote/bracket), whitespace, then a capital/digit/quote. */
const SENTENCE_BREAK_RE = /[.!?]["')\]]?\s+(?=[A-Z0-9"'([])/g;

/**
 * Split passage text into sentence-level segments. Fenced code blocks and table blocks are one
 * atomic segment each; every other line is split into sentences.
 */
export function segmentText(text: string): Segment[] {
  const out: Segment[] = [];
  const lines = text.split('\n');
  let pos = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const lineStart = pos;
    if (/^\s*(```|~~~)/.test(line)) {
      // Fenced code block: swallow lines until the closing fence (or the end of the passage).
      const fence = (line.match(/```|~~~/) as RegExpMatchArray)[0];
      let j = i + 1;
      let end = lineStart + line.length;
      while (j < lines.length) {
        end += 1 + (lines[j] as string).length;
        if ((lines[j] as string).trim().startsWith(fence)) break;
        j++;
      }
      out.push({ text: text.slice(lineStart, end), start: lineStart, end, kind: 'block' });
      pos = end + 1;
      i = j + 1;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      // Table: consecutive lines starting with a pipe.
      let j = i;
      let end = lineStart + line.length;
      while (j + 1 < lines.length && /^\s*\|/.test(lines[j + 1] as string)) {
        j++;
        end += 1 + (lines[j] as string).length;
      }
      out.push({ text: text.slice(lineStart, end), start: lineStart, end, kind: 'block' });
      pos = end + 1;
      i = j + 1;
      continue;
    }
    if (line.trim()) {
      const isLine = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(line);
      if (isLine)
        out.push({ text: line, start: lineStart, end: lineStart + line.length, kind: 'line' });
      else for (const s of splitSentences(line, lineStart)) out.push(s);
    }
    pos = lineStart + line.length + 1;
    i++;
  }
  return out;
}

function splitSentences(line: string, base: number): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  for (const m of line.matchAll(SENTENCE_BREAK_RE)) {
    const idx = m.index as number;
    // Boundary sits after the punctuation (and closing quote); whitespace goes to the next sentence.
    const punctEnd = idx + (m[0].match(/^\S+/) as RegExpMatchArray)[0].length;
    const candidate = line.slice(start, punctEnd);
    if (ABBREV_RE.test(candidate)) continue;
    if (candidate.trim().length < 15) continue; // "3. Foo" list-like fragments: keep together
    out.push({ text: candidate, start: base + start, end: base + punctEnd, kind: 'sentence' });
    start = idx + m[0].length;
  }
  if (start < line.length) {
    const rest = line.slice(start);
    if (rest.trim())
      out.push({ text: rest, start: base + start, end: base + line.length, kind: 'sentence' });
  }
  return out;
}

export interface HighlightOptions {
  /** Query terms → weight (e.g. idf; related-query terms at a lower weight). */
  terms: Map<string, number>;
  /** Max consecutive segments per window (default 3). */
  maxSegments?: number;
  /** Windows longer than this are skipped unless they are a single segment (default 600). */
  maxChars?: number;
  /** Return this many best windows (default 1); the first is the highlight. */
  top?: number;
}

export interface ScoredWindow extends Highlight {
  score: number;
  /** Idf-weighted share of query terms present (0..1). */
  coverage: number;
  /** Local offsets into the passage text. */
  localStart: number;
  localEnd: number;
}

const HEADING_RE = /^\s*#{1,6}\s/;

/**
 * Score every window of 1..maxSegments consecutive segments and return the best `top` windows.
 * score = idf-weighted coverage of query terms (0..1) + a small bonus for windows long enough to
 * read as evidence (up to ~200 chars) − penalties for extra segments and heading-only windows;
 * ties → shorter. Offsets are local to `text`; add the passage's startOffset for page offsets.
 */
export function rankHighlightWindows(text: string, opts: HighlightOptions): ScoredWindow[] {
  const segs = segmentText(text);
  if (segs.length === 0) return [];
  const maxSeg = opts.maxSegments ?? 3;
  const maxChars = opts.maxChars ?? 600;
  const totalW = [...opts.terms.values()].reduce((a, b) => a + b, 0) || 1;
  const segTerms = segs.map((s) => new Set(tokenize(s.text)));
  const wins: ScoredWindow[] = [];
  for (let i = 0; i < segs.length; i++) {
    const matched = new Set<string>();
    for (let j = i; j < segs.length && j - i < maxSeg; j++) {
      const seg = segs[j] as Segment;
      // Never bridge across a code/table block: it is a window on its own or not at all.
      if (j > i && (seg.kind === 'block' || (segs[j - 1] as Segment).kind === 'block')) break;
      for (const t of segTerms[j] as Set<string>) if (opts.terms.has(t)) matched.add(t);
      const start = (segs[i] as Segment).start;
      const end = seg.end;
      const len = end - start;
      if (j > i && len > maxChars) break;
      let w = 0;
      for (const t of matched) w += opts.terms.get(t) as number;
      const coverage = w / totalW;
      const headingsOnly = segs.slice(i, j + 1).every((s) => HEADING_RE.test(s.text));
      const score =
        coverage +
        0.1 * Math.min(1, len / 200) -
        0.02 * (j - i) -
        (headingsOnly ? 0.15 : 0) -
        (len > maxChars ? 0.1 : 0);
      wins.push({
        text: text.slice(start, end),
        startOffset: start,
        endOffset: end,
        localStart: start,
        localEnd: end,
        score,
        coverage,
      });
    }
  }
  wins.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  return wins.slice(0, opts.top ?? 1);
}

/** Page-offset Highlight from a scored window (trimmed, offsets adjusted). */
export function toHighlight(w: ScoredWindow, baseOffset: number): Highlight {
  const lead = w.text.length - w.text.trimStart().length;
  const trail = w.text.length - w.text.trimEnd().length;
  return {
    text: w.text.trim(),
    startOffset: baseOffset + w.localStart + lead,
    endOffset: baseOffset + w.localEnd - trail,
  };
}

/**
 * The lead window (first segments up to `maxChars`) — used when no query term matches, so the
 * highlight is still a readable opening rather than the shortest fragment.
 */
export function leadWindow(text: string, opts: HighlightOptions): ScoredWindow | undefined {
  const segs = segmentText(text);
  const first = segs[0];
  if (!first) return undefined;
  const maxSeg = opts.maxSegments ?? 3;
  const maxChars = opts.maxChars ?? 600;
  let end = first.end;
  for (let j = 1; j < segs.length && j < maxSeg; j++) {
    const seg = segs[j] as Segment;
    if (seg.kind === 'block' || seg.end - first.start > maxChars) break;
    end = seg.end;
  }
  const t = text.slice(first.start, end);
  return {
    text: t,
    startOffset: first.start,
    endOffset: end,
    localStart: first.start,
    localEnd: end,
    score: 0,
    coverage: 0,
  };
}

/** Convenience: best window as a page-offset Highlight (or the lead segment when nothing matches). */
export function bestHighlight(
  text: string,
  baseOffset: number,
  opts: HighlightOptions,
): Highlight | undefined {
  let [w] = rankHighlightWindows(text, opts);
  if (!w || w.coverage <= 0) w = leadWindow(text, opts);
  if (!w) return undefined;
  return toHighlight(w, baseOffset);
}
