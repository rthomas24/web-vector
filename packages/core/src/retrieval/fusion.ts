import type { ScoredChunk } from '../types.js';
import { dot } from '../util/vector.js';

export interface Ranked {
  id: string;
  score: number;
}

/** Weighted Reciprocal Rank Fusion (k = 60 default). */
export function rrf(lists: Ranked[][], opts: { k?: number; weights?: number[] } = {}): Ranked[] {
  const k = opts.k ?? 60;
  const acc = new Map<string, number>();
  lists.forEach((list, li) => {
    const w = opts.weights?.[li] ?? 1;
    if (w === 0) return;
    list.forEach((h, rank) => acc.set(h.id, (acc.get(h.id) ?? 0) + w / (k + rank + 1)));
  });
  return [...acc].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

export function minMaxNormalize(list: Ranked[]): Ranked[] {
  if (list.length === 0) return list;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const h of list) {
    if (h.score < lo) lo = h.score;
    if (h.score > hi) hi = h.score;
  }
  return list.map((h) => ({ ...h, score: hi === lo ? 1 : (h.score - lo) / (hi - lo) }));
}

/** Distribution-based score fusion normaliser (mean ± 3σ, clipped to [0,1]). */
export function dbsfNormalize(list: Ranked[]): Ranked[] {
  const n = list.length;
  if (n === 0) return list;
  const mu = list.reduce((a, b) => a + b.score, 0) / n;
  const sd = Math.sqrt(list.reduce((a, b) => a + (b.score - mu) ** 2, 0) / n) || 1e-9;
  const lo = mu - 3 * sd;
  const hi = mu + 3 * sd;
  return list.map((h) => ({ ...h, score: Math.min(1, Math.max(0, (h.score - lo) / (hi - lo))) }));
}

/** Convex combination of normalised score lists. */
export function scoreFusion(
  lists: Ranked[][],
  weights: number[],
  norm: (l: Ranked[]) => Ranked[] = minMaxNormalize,
): Ranked[] {
  const acc = new Map<string, number>();
  lists.forEach((l, i) =>
    norm(l).forEach((h) => acc.set(h.id, (acc.get(h.id) ?? 0) + (weights[i] ?? 1) * h.score)),
  );
  return [...acc].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

export interface MmrOptions<T> {
  /** Relevance per candidate (same order). Defaults to cosine(query, vector) or `score`. */
  relevance?: number[];
  /**
   * Redundancy between two candidates in [0, 1]. Defaults to cosine over vectors when every
   * candidate has one, else word-3-gram Jaccard over `text` (lexical mode).
   */
  similarity?: (a: T, b: T) => number;
}

/**
 * Maximal Marginal Relevance: greedily pick argmax λ·rel(i) − (1−λ)·max_j sim(i, j).
 * Works with vectors (cosine) or without (shingle Jaccard on text). λ=1 → pure relevance.
 */
export function mmr<T extends { vector?: Float32Array; score: number; text?: string }>(
  queryVector: Float32Array | undefined,
  cands: T[],
  k: number,
  lambda = 0.7,
  opts: MmrOptions<T> = {},
): T[] {
  if (cands.length <= k || lambda >= 1) return cands.slice(0, k);
  const withVec = cands.every((c) => c.vector);
  const sim =
    opts.similarity ??
    (withVec
      ? (a: T, b: T) => dot(a.vector as Float32Array, b.vector as Float32Array)
      : (a: T, b: T) => shingleJaccard(a.text ?? '', b.text ?? '', 3));
  // Relevance and cosine redundancy share a scale; for lexical mode callers pass normalised scores.
  const relN =
    opts.relevance ??
    cands.map((c) =>
      withVec && queryVector ? dot(queryVector, c.vector as Float32Array) : c.score,
    );
  const chosen: number[] = [];
  const remaining = new Set(cands.map((_, i) => i));
  while (chosen.length < k && remaining.size) {
    let best = -1;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (const i of remaining) {
      let red = 0;
      for (const j of chosen) red = Math.max(red, sim(cands[i] as T, cands[j] as T));
      const v = lambda * (relN[i] as number) - (1 - lambda) * red;
      if (v > bestVal) {
        bestVal = v;
        best = i;
      }
    }
    chosen.push(best);
    remaining.delete(best);
  }
  return chosen.map((i) => cands[i] as T);
}

/**
 * Cut a score-sorted list where the score curve "jumps": a gap larger than `factor` × the mean gap
 * counts as one jump; the list is cut after `jumps` such jumps. Always keeps `minKeep` items.
 * Returns the number of items to keep.
 */
export function autocut(
  scores: number[],
  jumps = 1,
  opts: { factor?: number; minKeep?: number } = {},
): number {
  const n = scores.length;
  const minKeep = Math.min(opts.minKeep ?? 3, n);
  if (n <= minKeep || jumps <= 0) return n;
  const factor = opts.factor ?? 3;
  const gaps: number[] = [];
  for (let i = 0; i + 1 < n; i++) gaps.push((scores[i] as number) - (scores[i + 1] as number));
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (!(mean > 0)) return n;
  let seen = 0;
  for (let i = 0; i < gaps.length; i++) {
    if ((gaps[i] as number) > factor * mean) {
      seen++;
      if (seen >= jumps && i + 1 >= minKeep) return i + 1;
    }
  }
  return n;
}

/** Cap chunks per source URL, then round-robin across sources preserving score order within each. */
export function diversifyBySource<T extends { metadata: { canonicalUrl: string }; score: number }>(
  hits: T[],
  maxPerSource: number,
  k: number,
): T[] {
  const bySrc = new Map<string, T[]>();
  for (const h of hits) {
    const key = h.metadata.canonicalUrl;
    const arr = bySrc.get(key);
    if (arr) {
      if (arr.length < maxPerSource) arr.push(h);
    } else bySrc.set(key, [h]);
  }
  // sources ordered by their best hit
  const queues = [...bySrc.values()].sort((a, b) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0));
  const out: T[] = [];
  let progressed = true;
  while (out.length < k && progressed) {
    progressed = false;
    for (const q of queues) {
      if (q.length && out.length < k) {
        out.push(q.shift() as T);
        progressed = true;
      }
    }
  }
  return out;
}

/** Jaccard similarity of word 5-gram shingles (near-duplicate detection). */
export function shingleJaccard(a: string, b: string, n = 5): number {
  const sa = shingles(a, n);
  const sb = shingles(b, n);
  if (sa.size === 0 || sb.size === 0) return a === b ? 1 : 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function shingles(text: string, n: number): Set<string> {
  const words = text.toLowerCase().split(/\W+/).filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length) out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/** Remove exact and near duplicates (by contentHash then shingle Jaccard), keeping the higher-scored. */
export function dedupeChunks<T extends ScoredChunk>(chunks: T[], threshold = 0.9): T[] {
  const out: T[] = [];
  const seenHash = new Set<string>();
  for (const c of chunks) {
    const h = c.metadata.contentHash;
    if (h && seenHash.has(h)) continue;
    let dup = false;
    if (threshold < 1) {
      for (const o of out) {
        if (
          Math.abs(o.text.length - c.text.length) / Math.max(o.text.length, c.text.length, 1) >
          0.5
        )
          continue;
        if (shingleJaccard(o.text, c.text) >= threshold) {
          dup = true;
          break;
        }
      }
    }
    if (dup) continue;
    if (h) seenHash.add(h);
    out.push(c);
  }
  return out;
}

// ─── Adjacent-chunk merge ────────────────────────────────────────────────────

/** The minimum a chunk needs to carry for `groupAdjacent` / `joinAdjacentText`. */
export interface Adjacent {
  text: string;
  metadata: { canonicalUrl: string; chunkIndex: number; startOffset: number; endOffset: number };
}

/**
 * Group items that are neighbours on the same page (same canonical URL, consecutive `chunkIndex`)
 * so they can be returned as one passage. Each group is sorted by chunkIndex; the outer order
 * follows the first appearance of each group in `items` (i.e. score order is preserved).
 */
export function groupAdjacent<T extends Adjacent>(items: T[]): T[][] {
  const byUrl = new Map<string, T[]>();
  for (const it of items) {
    const arr = byUrl.get(it.metadata.canonicalUrl);
    if (arr) arr.push(it);
    else byUrl.set(it.metadata.canonicalUrl, [it]);
  }
  const groupOf = new Map<T, T[]>();
  for (const arr of byUrl.values()) {
    const sorted = [...arr].sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
    let cur: T[] = [];
    for (const it of sorted) {
      const prev = cur.at(-1);
      if (prev && it.metadata.chunkIndex === prev.metadata.chunkIndex + 1) cur.push(it);
      else {
        cur = [it];
      }
      groupOf.set(it, cur);
    }
  }
  const out: T[][] = [];
  const seen = new Set<T[]>();
  for (const it of items) {
    const g = groupOf.get(it) as T[];
    if (seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  return out;
}

/**
 * Join the text of two consecutive chunks without repeating the chunker's overlap.
 * Uses the page offsets when they agree with the text (B starts inside A), otherwise looks for the
 * longest suffix of A that B starts with, and finally falls back to a paragraph break.
 */
export function joinAdjacentText(a: Adjacent, b: Adjacent): string {
  const ov = a.metadata.endOffset - b.metadata.startOffset;
  if (ov > 0 && ov <= b.text.length && ov <= a.text.length) {
    if (a.text.slice(-ov) === b.text.slice(0, ov)) return a.text + b.text.slice(ov);
  }
  // Offsets are a couple of chars off at times (chunker overlap across a paragraph gap): scan.
  const max = Math.min(a.text.length, b.text.length, 2000);
  for (let k = max; k >= 20; k--) {
    if (a.text.endsWith(b.text.slice(0, k))) return a.text + b.text.slice(k);
  }
  return `${a.text}\n\n${b.text}`;
}
