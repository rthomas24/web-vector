/** Dependency-free Okapi BM25 over in-memory documents (chunk texts). */

const STOPWORDS = new Set(
  'a an the and or of to in on for with is are was were be been being by as at it its this that these those from into over under about after before between during without within than then there here how what which who whom whose why when where can could should would will shall may might must do does did done have has had having not no nor so such very just also only own same too more most other some any each few both all if but because while until against up down out off again further once i me my we our you your he him his she her they them their'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(lightStem);
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

interface Doc {
  id: string;
  tf: Map<string, number>;
  len: number;
}

export class BM25Index {
  private readonly docs = new Map<string, Doc>();
  private readonly df = new Map<string, number>();
  private totalLen = 0;
  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  add(id: string, text: string): void {
    if (this.docs.has(id)) return;
    const toks = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.set(id, { id, tf, len: toks.length });
    this.totalLen += toks.length;
  }

  remove(id: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    for (const t of d.tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1;
      if (n <= 0) this.df.delete(t);
      else this.df.set(t, n);
    }
    this.totalLen -= d.len;
    this.docs.delete(id);
  }

  clear(): void {
    this.docs.clear();
    this.df.clear();
    this.totalLen = 0;
  }

  search(query: string, k = 20, filter?: (id: string) => boolean): { id: string; score: number }[] {
    const N = this.docs.size;
    if (N === 0) return [];
    const avgdl = this.totalLen / N;
    const q = [...new Set(tokenize(query))];
    if (q.length === 0) return [];
    const idf = new Map<string, number>();
    for (const t of q) {
      const n = this.df.get(t);
      if (n) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }
    if (idf.size === 0) return [];
    const out: { id: string; score: number }[] = [];
    for (const d of this.docs.values()) {
      if (filter && !filter(d.id)) continue;
      let s = 0;
      for (const [t, w] of idf) {
        const tf = d.tf.get(t);
        if (!tf) continue;
        s += (w * (tf * (this.k1 + 1))) / (tf + this.k1 * (1 - this.b + (this.b * d.len) / avgdl));
      }
      if (s > 0) out.push({ id: d.id, score: s });
    }
    out.sort((a, b) => b.score - a.score);
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
