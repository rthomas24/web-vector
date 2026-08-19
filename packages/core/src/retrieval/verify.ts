/**
 * Quote-grounding verifier: is each sentence of an answer actually supported by the passage it
 * cites? Deterministic and model-free — the cheap half of citation faithfulness.
 *
 *   verbatim     the normalised sentence is a substring of the cited source
 *   paraphrase   best source window has word-3-gram Jaccard ≥ 0.6 or ROUGE-L F1 ≥ 0.7
 *   unsupported  cited, but neither of the above
 *   uncited      no [n] marker and no passage supports it either
 *
 * Numbers and dates in a sentence that never appear in its sources are flagged separately: they
 * are the most common hallucination that still "reads" like the source.
 *
 * ROUGE-L here is the standard LCS-based F-measure (Lin 2004): P = LCS/|candidate|,
 * R = LCS/|reference|, F = 2PR/(P+R), computed against the best-matching 1–2 sentence window of the
 * source rather than the whole passage (a 300-word passage would dwarf any single sentence).
 */
import type { Passage } from '../types.js';
import { segmentText } from './highlight.js';

export type CitationStatus = 'verbatim' | 'paraphrase' | 'unsupported' | 'uncited';

export interface SentenceCheck {
  sentence: string;
  /** [n] markers found in the sentence. */
  citations: number[];
  status: CitationStatus;
  /** Passage index that supports the sentence best (may be uncited — a suggestion). */
  bestIndex?: number;
  /** Best similarity in [0, 1] (1 = verbatim). */
  score: number;
  /** Numbers / dates in the sentence that appear in none of its sources. */
  unsupportedNumbers: string[];
}

export interface VerifyResult {
  sentences: SentenceCheck[];
  summary: {
    total: number;
    verbatim: number;
    paraphrase: number;
    unsupported: number;
    uncited: number;
    /** (verbatim + paraphrase) / total, 0..1. */
    supportRate: number;
  };
  /** Markers that point at no known passage. */
  unknownCitations: number[];
}

export interface VerifySource {
  index: number;
  /** The passage text (what was shown to the model). */
  text: string;
  /** Optional whole-page text (when the session still has the page), searched after `text`. */
  pageText?: string;
}

export interface VerifyOptions {
  jaccardThreshold?: number;
  rougeThreshold?: number;
}

const CITE_RE = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g;

/** Lowercase, drop markdown/punctuation and citation markers, collapse whitespace. */
export function normalizeForMatch(text: string): string {
  return text
    .replace(CITE_RE, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s%.]/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ') // keep decimals, drop other periods
    .replace(/\s+/g, ' ')
    .trim();
}

function words(s: string): string[] {
  return s.split(' ').filter(Boolean);
}

function ngrams(ws: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(' '));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Longest common subsequence length over word arrays (O(n·m), inputs are sentence-sized). */
export function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] =
        a[i - 1] === b[j - 1]
          ? (prev[j - 1] as number) + 1
          : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] as number;
}

/** ROUGE-L F1 between two word arrays. */
export function rougeL(candidate: string[], reference: string[]): number {
  const l = lcsLength(candidate, reference);
  if (l === 0) return 0;
  const p = l / candidate.length;
  const r = l / reference.length;
  return (2 * p * r) / (p + r);
}

/** Numbers, percentages, years and ISO dates in a sentence (normalised: no thousands separators). */
export function extractNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b\d[\d,]*(?:\.\d+)?%?/g)) {
    const raw = m[0].replace(/,/g, '');
    if (raw.length === 0) continue;
    out.add(raw);
  }
  return [...out];
}

interface Match {
  score: number;
  status: 'verbatim' | 'paraphrase' | 'unsupported';
}

/** Best support for a normalised sentence inside one source text. */
function matchAgainst(
  sentenceNorm: string,
  sourceRaw: string,
  opts: Required<VerifyOptions>,
): Match {
  const sourceNorm = normalizeForMatch(sourceRaw);
  const sw = words(sentenceNorm);
  if (sw.length === 0 || sourceNorm.length === 0) return { score: 0, status: 'unsupported' };
  if (sw.length >= 3 && sourceNorm.includes(sentenceNorm)) return { score: 1, status: 'verbatim' };
  // Best 1–2 sentence window of the source.
  const segs = segmentText(sourceRaw).map((s) => words(normalizeForMatch(s.text)));
  const s3 = ngrams(sw, 3);
  let best = 0;
  let hit = false;
  for (let i = 0; i < segs.length; i++) {
    for (let span = 1; span <= 2 && i + span <= segs.length; span++) {
      const win = segs.slice(i, i + span).flat();
      if (win.length === 0) continue;
      const j = s3.size ? jaccard(s3, ngrams(win, 3)) : 0;
      const r = rougeL(sw, win);
      if (j >= opts.jaccardThreshold || r >= opts.rougeThreshold) hit = true;
      best = Math.max(best, j, r);
    }
  }
  return { score: Number(best.toFixed(3)), status: hit ? 'paraphrase' : 'unsupported' };
}

/** Split an answer into checkable sentences (markdown-aware; code/tables stay whole). */
export function answerSentences(answer: string): string[] {
  return segmentText(answer)
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0 && words(normalizeForMatch(t)).length >= 3);
}

/**
 * Verify an answer's [n] citations against the passages they refer to.
 * `sources` = passages (index, text, optional whole-page text) the answer could cite.
 */
export function verifyCitations(
  answer: string,
  sources: VerifySource[],
  options: VerifyOptions = {},
): VerifyResult {
  const opts: Required<VerifyOptions> = {
    jaccardThreshold: options.jaccardThreshold ?? 0.6,
    rougeThreshold: options.rougeThreshold ?? 0.7,
  };
  const byIndex = new Map(sources.map((s) => [s.index, s]));
  const unknown = new Set<number>();
  const sentences: SentenceCheck[] = [];
  for (const sentence of answerSentences(answer)) {
    const citations: number[] = [];
    for (const m of sentence.matchAll(CITE_RE)) {
      for (const n of (m[1] as string).split(/\s*[,;]\s*/)) {
        const k = Number(n);
        if (!citations.includes(k)) citations.push(k);
        if (!byIndex.has(k)) unknown.add(k);
      }
    }
    const norm = normalizeForMatch(sentence);
    const candidates = citations.length
      ? citations.map((k) => byIndex.get(k)).filter((s): s is VerifySource => !!s)
      : sources;
    let best: { index?: number; match: Match } = { match: { score: 0, status: 'unsupported' } };
    for (const src of candidates) {
      for (const text of [src.text, src.pageText]) {
        if (!text) continue;
        const m = matchAgainst(norm, text, opts);
        if (
          m.score > best.match.score ||
          (m.status === 'verbatim' && best.match.status !== 'verbatim')
        )
          best = { index: src.index, match: m };
        if (m.status === 'verbatim') break;
      }
      if (best.match.status === 'verbatim') break;
    }
    // Numbers/dates must appear in at least one cited (or, if uncited, any) source.
    const nums = extractNumbers(sentence.replace(CITE_RE, ' '));
    const sourceBlob = candidates
      .map((s) => `${s.text}\n${s.pageText ?? ''}`)
      .join('\n')
      .replace(/,(?=\d{3}\b)/g, '');
    const unsupportedNumbers = nums.filter((n) => !sourceBlob.includes(n));
    let status: CitationStatus = best.match.status;
    if (citations.length === 0 && status === 'unsupported') status = 'uncited';
    sentences.push({
      sentence,
      citations,
      status,
      bestIndex: best.index,
      score: best.match.score,
      unsupportedNumbers,
    });
  }
  const count = (s: CitationStatus) => sentences.filter((x) => x.status === s).length;
  const total = sentences.length;
  const supported = count('verbatim') + count('paraphrase');
  return {
    sentences,
    summary: {
      total,
      verbatim: count('verbatim'),
      paraphrase: count('paraphrase'),
      unsupported: count('unsupported'),
      uncited: count('uncited'),
      supportRate: total ? Number((supported / total).toFixed(3)) : 0,
    },
    unknownCitations: [...unknown].sort((a, b) => a - b),
  };
}

/** Build verifier sources from a research result's passages (+ optional page texts by URL). */
export function sourcesFromPassages(
  passages: Passage[],
  pageTextByUrl?: Map<string, string>,
): VerifySource[] {
  return passages.map((p) => ({
    index: p.index,
    text: p.text,
    pageText: pageTextByUrl?.get(p.url),
  }));
}
