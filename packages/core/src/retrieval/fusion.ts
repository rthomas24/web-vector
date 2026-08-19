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

/** Maximal Marginal Relevance over candidates that carry vectors; λ=1 → pure relevance. */
export function mmr<T extends { vector?: Float32Array; score: number }>(
  queryVector: Float32Array | undefined,
  cands: T[],
  k: number,
  lambda = 0.7,
): T[] {
  if (cands.length <= k || lambda >= 1) return cands.slice(0, k);
  const withVec = cands.every((c) => c.vector);
  if (!withVec) return cands.slice(0, k);
  // Relevance and redundancy are both cosine similarities (same scale), so no normalisation.
  const relN = cands.map((c) =>
    queryVector ? dot(queryVector, c.vector as Float32Array) : c.score,
  );
  const chosen: number[] = [];
  const remaining = new Set(cands.map((_, i) => i));
  while (chosen.length < k && remaining.size) {
    let best = -1;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (const i of remaining) {
      let red = 0;
      for (const j of chosen)
        red = Math.max(
          red,
          dot(cands[i]!.vector as Float32Array, cands[j]!.vector as Float32Array),
        );
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
