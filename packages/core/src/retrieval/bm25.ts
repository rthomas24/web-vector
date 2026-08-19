/**
 * Dependency-free lexical index over in-memory chunks.
 *
 * - **BM25F fields**: title / breadcrumb / body are indexed as separate fields; term frequencies are
 *   length-normalised per field and combined with field weights *before* saturation
 *   (Zaragoza et al., "Simple BM25F"), so a match in a heading counts more than one in the body.
 * - **Variants**: `okapi` (classic BM25 saturation) or `bmx` (BMX: entropy-weighted query-coverage
 *   bonus, α replacing k1/b — Li et al. 2024, arXiv:2408.06643).
 * - **BM25+** lower bound (`delta`) so long chunks that do contain a rare term never score below a
 *   short chunk that lacks it.
 * - **Proximity**: token positions are kept for the body field so queries with ≥2 matched terms get
 *   a bonus when those terms co-occur in a tight window (min-span), and quoted phrases must match
 *   exactly.
 * - **Identifier-aware tokenizer**: `AbortSignal.any`, `text-embedding-3-small`, `2025-11-25`,
 *   `snake_case` are kept as single tokens *in addition to* their parts.
 */

const STOPWORDS = new Set(
  'a an the and or of to in on for with is are was were be been being by as at it its this that these those from into over under about after before between during without within than then there here how what which who whom whose why when where can could should would will shall may might must do does did done have has had having not no nor so such very just also only own same too more most other some any each few both all if but because while until against up down out off again further once i me my we our you your he him his she her they them their'.split(
    ' ',
  ),
);

/** Compound identifiers: letters/digits joined by `.`, `-` or `_` (kept whole, un-stemmed). */
const COMPOUND_RE = /[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)+/gu;
/** Combining diacritical marks (stripped after NFKD). */
const DIACRITICS_RE = /[̀-ͯ]/g;
const NON_WORD_RE = /[^\p{L}\p{N}\s]/gu;

export interface PositionedToken {
  token: string;
  /** Ordinal of the word in the original text (stopwords count, so "rank and fusion" spans 3). */
  pos: number;
}

/** Tokenize keeping word positions (used for proximity and quoted-phrase matching). */
export function tokenizeWithPositions(text: string): PositionedToken[] {
  const lower = text.toLowerCase().normalize('NFKD').replace(DIACRITICS_RE, '');
  const out: PositionedToken[] = [];
  // Word ordinals over the raw text (before stopword/length filtering).
  const wordStarts: number[] = [];
  const cleaned = lower.replace(NON_WORD_RE, ' ');
  for (const m of cleaned.matchAll(/\S+/g)) wordStarts.push(m.index as number);
  const ordinalAt = (charIndex: number): number => {
    // last word start ≤ charIndex (binary search)
    let lo = 0;
    let hi = wordStarts.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((wordStarts[mid] as number) <= charIndex) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  };
  for (const m of lower.matchAll(COMPOUND_RE)) {
    const c = m[0];
    // Keep dates/versions/identifiers; skip short decimals like "1.5" which are too common to help.
    if (c.length > 4 || /\p{L}/u.test(c)) out.push({ token: c, pos: ordinalAt(m.index as number) });
  }
  let ordinal = 0;
  for (const m of cleaned.matchAll(/\S+/g)) {
    const w = m[0];
    const pos = ordinal++;
    if (w.length > 1 && !STOPWORDS.has(w)) out.push({ token: lightStem(w), pos });
  }
  return out;
}

export function tokenize(text: string): string[] {
  return tokenizeWithPositions(text).map((t) => t.token);
}

/** Very light English suffix stripping (plural/ing/ed) — cheap recall boost without a stemmer dependency. */
export function lightStem(t: string): string {
  if (t.length <= 4) return t;
  if (t.endsWith('ies') && t.length > 5) return `${t.slice(0, -3)}y`;
  if (t.endsWith('sses')) return t.slice(0, -2);
  if (t.endsWith('ing') && t.length > 6) return t.slice(0, -3);
  if (t.endsWith('ed') && t.length > 5) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is'))
    return t.slice(0, -1);
  return t;
}

/** Quoted phrases in a query (`"exact words"`), tokenized with relative word offsets. */
export function quotedPhrases(query: string): PositionedToken[][] {
  const out: PositionedToken[][] = [];
  for (const m of query.matchAll(/"([^"]{2,})"/g)) {
    const toks = tokenizeWithPositions(m[1] as string).filter((t) => !t.token.includes('.'));
    if (toks.length >= 2) out.push(toks);
  }
  return out;
}

export type BM25Fields = Record<string, string>;

export interface BM25Options {
  /** Saturation (okapi). Default 1.2. */
  k1?: number;
  /** Length normalisation (okapi). Default 0.75. */
  b?: number;
  /** Field weights, e.g. `{ title: 2.5, breadcrumb: 1.5, body: 1 }`. Unknown fields weight 1. */
  fieldWeights?: Record<string, number>;
  /** `okapi` (default) or `bmx`. */
  variant?: 'okapi' | 'bmx';
  /** BM25+ lower bound added to every matching term's tf part. Default 0. */
  delta?: number;
  /** Weight of the query-coverage bonus (fraction of distinct query terms present). Default 0. */
  coverageWeight?: number;
  /** Weight of the proximity (min-span) bonus. Default 0 (off). */
  proximityWeight?: number;
  /** Which field carries positions for proximity/quoted phrases. Default `body`. */
  positionsField?: string;
}

interface Doc {
  id: string;
  /** field → (term → tf) */
  tf: Map<string, Map<string, number>>;
  /** field → token count */
  len: Map<string, number>;
  /** term → positions in the positions field */
  positions?: Map<string, number[]>;
}

export interface BM25Hit {
  id: string;
  score: number;
}

export class BM25Index {
  private readonly docs = new Map<string, Doc>();
  /** term → docId → summed (unweighted) tf across fields — for df and BMX entropy. */
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly totalLen = new Map<string, number>();
  private readonly opts: Required<
    Pick<
      BM25Options,
      'k1' | 'b' | 'variant' | 'delta' | 'coverageWeight' | 'proximityWeight' | 'positionsField'
    >
  > & { fieldWeights: Record<string, number> };

  constructor(opts: BM25Options | number = {}, legacyB?: number) {
    // Back-compat: `new BM25Index(k1, b)`.
    const o: BM25Options = typeof opts === 'number' ? { k1: opts, b: legacyB } : opts;
    this.opts = {
      k1: o.k1 ?? 1.2,
      b: o.b ?? 0.75,
      variant: o.variant ?? 'okapi',
      delta: o.delta ?? 0,
      coverageWeight: o.coverageWeight ?? 0,
      proximityWeight: o.proximityWeight ?? 0,
      positionsField: o.positionsField ?? 'body',
      fieldWeights: o.fieldWeights ?? {},
    };
  }

  get size(): number {
    return this.docs.size;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  /** Inverse document frequency of an (already tokenized) term; 0 when unseen. */
  idf(term: string): number {
    const N = this.docs.size;
    const n = this.postings.get(term)?.size ?? 0;
    return n ? Math.log(1 + (N - n + 0.5) / (n + 0.5)) : 0;
  }

  /** Index a document. A plain string is indexed as the `body` field. */
  add(id: string, text: string | BM25Fields): void {
    if (this.docs.has(id)) return;
    const fields: BM25Fields = typeof text === 'string' ? { body: text } : text;
    const doc: Doc = { id, tf: new Map(), len: new Map() };
    const combined = new Map<string, number>();
    for (const [field, value] of Object.entries(fields)) {
      if (!value) continue;
      const toks = tokenizeWithPositions(value);
      const tf = new Map<string, number>();
      let positions: Map<string, number[]> | undefined;
      if (field === this.opts.positionsField) {
        positions = new Map();
        doc.positions = positions;
      }
      for (const { token: t, pos } of toks) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
        combined.set(t, (combined.get(t) ?? 0) + 1);
        if (positions) {
          const arr = positions.get(t);
          if (arr) arr.push(pos);
          else positions.set(t, [pos]);
        }
      }
      doc.tf.set(field, tf);
      doc.len.set(field, toks.length);
      this.totalLen.set(field, (this.totalLen.get(field) ?? 0) + toks.length);
    }
    for (const [t, n] of combined) {
      let p = this.postings.get(t);
      if (!p) {
        p = new Map();
        this.postings.set(t, p);
      }
      p.set(id, n);
    }
    this.docs.set(id, doc);
  }

  remove(id: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    for (const [field, tf] of d.tf) {
      this.totalLen.set(field, (this.totalLen.get(field) ?? 0) - (d.len.get(field) ?? 0));
      for (const t of tf.keys()) {
        const p = this.postings.get(t);
        if (!p) continue;
        p.delete(id);
        if (p.size === 0) this.postings.delete(t);
      }
    }
    this.docs.delete(id);
  }

  clear(): void {
    this.docs.clear();
    this.postings.clear();
    this.totalLen.clear();
  }

  search(query: string, k = 20, filter?: (id: string) => boolean): BM25Hit[] {
    const N = this.docs.size;
    if (N === 0) return [];
    const q = [...new Set(tokenize(query))];
    if (q.length === 0) return [];
    const phrases = quotedPhrases(query);

    // IDF per query term (Robertson/Sparck-Jones with +1 inside the log, as Lucene).
    const idf = new Map<string, number>();
    for (const t of q) {
      const n = this.postings.get(t)?.size ?? 0;
      if (n) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }
    if (idf.size === 0) return [];
    const matchedTerms = [...idf.keys()];

    // Candidate docs = union of postings (avoids scanning every doc).
    const candidates = new Set<string>();
    for (const t of matchedTerms) for (const id of this.postings.get(t)!.keys()) candidates.add(id);

    // Per-field average lengths.
    const avgLen = new Map<string, number>();
    for (const [f, tot] of this.totalLen) avgLen.set(f, tot / N || 1);

    // BMX: normalised token entropy E(q) and mean entropy ℰ.
    let entropy: Map<string, number> | undefined;
    let meanEntropy = 0;
    const isBmx = this.opts.variant === 'bmx';
    if (isBmx || this.opts.coverageWeight > 0) {
      entropy = new Map();
      let maxE = 0;
      for (const t of matchedTerms) {
        let e = 0;
        for (const tf of this.postings.get(t)!.values()) {
          const p = 1 / (1 + Math.exp(-tf));
          e -= p * Math.log(p);
        }
        entropy.set(t, e);
        if (e > maxE) maxE = e;
      }
      for (const [t, e] of entropy) entropy.set(t, maxE > 0 ? e / maxE : 1);
      meanEntropy = [...entropy.values()].reduce((a, b) => a + b, 0) / Math.max(1, entropy.size);
    }
    const alpha = Math.max(0.5, Math.min(1.5, (avgLen.get('body') ?? 100) / 100));
    const beta = 1 / Math.log(1 + N);
    const coverageW = isBmx ? beta : this.opts.coverageWeight;

    const { k1, b, delta, fieldWeights, proximityWeight } = this.opts;
    const out: BM25Hit[] = [];
    for (const id of candidates) {
      if (filter && !filter(id)) continue;
      const d = this.docs.get(id)!;
      let s = 0;
      let present = 0;
      const presentTerms: string[] = [];
      for (const [t, w] of idf) {
        // BM25F: length-normalised, weighted tf combined across fields *before* saturation.
        let F = 0;
        for (const [field, tf] of d.tf) {
          const f = tf.get(t);
          if (!f) continue;
          const B = 1 - b + (b * (d.len.get(field) ?? 0)) / (avgLen.get(field) ?? 1);
          F += ((fieldWeights[field] ?? 1) * f) / B;
        }
        if (F <= 0) continue;
        present++;
        presentTerms.push(t);
        const tfPart = isBmx
          ? (F * (alpha + 1)) / (F + alpha + alpha * meanEntropy)
          : (F * (k1 + 1)) / (F + k1);
        s += w * (tfPart + delta);
      }
      if (present === 0) continue;
      // Coverage bonus (BMX: β·E(q)·S(Q,D) summed over query terms; okapi: coverageWeight·S).
      if (coverageW > 0) {
        const S = present / q.length;
        if (isBmx) for (const t of presentTerms) s += coverageW * (entropy!.get(t) ?? 1) * S;
        else s += coverageW * S * present;
      }
      // Quoted phrases must appear verbatim (adjacent positions); otherwise drop the doc.
      if (phrases.length && d.positions) {
        if (!phrases.every((ph) => hasPhrase(d.positions!, ph))) continue;
      }
      // Proximity: bonus when ≥2 matched terms co-occur in a tight window.
      if (proximityWeight > 0 && present >= 2 && d.positions) {
        const span = minSpan(d.positions, presentTerms);
        if (span > 0) {
          const idfSum = presentTerms.reduce((a, t) => a + (idf.get(t) ?? 0), 0);
          s += proximityWeight * (present / span) * idfSum;
        }
      }
      if (s > 0) out.push({ id, score: s });
    }
    out.sort((x, y) => y.score - x.score);
    return out.slice(0, k);
  }

  /** Top-e terms by tf-idf across the given texts (pseudo-relevance feedback). */
  static topTerms(texts: string[], e = 8, exclude: Set<string> = new Set()): string[] {
    const tf = new Map<string, number>();
    const df = new Map<string, number>();
    for (const text of texts) {
      const toks = tokenize(text);
      const seen = new Set<string>();
      for (const t of toks) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
        if (!seen.has(t)) {
          seen.add(t);
          df.set(t, (df.get(t) ?? 0) + 1);
        }
      }
    }
    const N = Math.max(1, texts.length);
    return [...tf.entries()]
      .filter(([t]) => !exclude.has(t) && !/^\d+$/.test(t))
      .map(([t, f]) => ({
        t,
        w: f * Math.log(1 + N / (df.get(t) ?? 1)) * (df.get(t)! > 1 ? 1.5 : 1),
      }))
      .sort((a, b) => b.w - a.w)
      .slice(0, e)
      .map((x) => x.t);
  }
}

/** True when the phrase tokens occur with the same relative word offsets as in the query. */
function hasPhrase(positions: Map<string, number[]>, phrase: PositionedToken[]): boolean {
  const first = phrase[0] as PositionedToken;
  const firstPositions = positions.get(first.token);
  if (!firstPositions) return false;
  const rest = phrase
    .slice(1)
    .map((t) => ({ arr: positions.get(t.token), off: t.pos - first.pos }));
  if (rest.some((r) => !r.arr)) return false;
  outer: for (const p of firstPositions) {
    for (const r of rest) {
      // positions are sorted ascending; chunk-sized docs make a linear scan fine
      if (!(r.arr as number[]).includes(p + r.off)) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Length of the smallest window containing at least one occurrence of every term
 * (classic sorted-merge sweep). Returns 0 if any term is missing.
 */
function minSpan(positions: Map<string, number[]>, terms: string[]): number {
  const lists = terms.map((t) => positions.get(t));
  if (lists.some((l) => !l || l.length === 0)) return 0;
  const idx = new Array(lists.length).fill(0) as number[];
  let best = Number.POSITIVE_INFINITY;
  for (;;) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let loList = -1;
    for (let i = 0; i < lists.length; i++) {
      const v = (lists[i] as number[])[idx[i] as number] as number;
      if (v < lo) {
        lo = v;
        loList = i;
      }
      if (v > hi) hi = v;
    }
    const span = hi - lo + 1;
    if (span < best) best = span;
    if (best === lists.length) break; // can't do better than all-adjacent
    idx[loList] = (idx[loList] as number) + 1;
    if ((idx[loList] as number) >= (lists[loList] as number[]).length) break;
  }
  return best;
}
