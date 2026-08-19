/**
 * Same-host boilerplate suppression at ingest time.
 *
 * Navigation blocks, footers, "related posts" rails and cookie text that survive extraction tend to
 * repeat verbatim (or near-verbatim) on every page of a host. Within one session, a chunk whose
 * content hash — or ≥ 80 % of whose word shingles — was already seen on a *different* URL of the
 * same host is boilerplate: it is dropped from the new page and the earlier copies are reported so
 * the caller can retract them from the lexical index. Code blocks are never dropped. When most of a
 * page matches (≥ 80 % of its chunks) the page is a duplicate, not boilerplate-laden: the matching
 * chunks are dropped from the new page only.
 */

export interface BoilerplateChunk {
  id: string;
  url: string;
  text: string;
  contentHash: string;
}

export interface BoilerplateVerdict {
  /** Chunk ids (from the incoming page) to drop. */
  drop: Set<string>;
  /** Earlier chunk ids on the same host that matched and should be retracted. */
  retract: Set<string>;
  /** Incoming page looked like a duplicate of an earlier page (matches ≥ 80 %). */
  duplicatePage: boolean;
}

interface Record {
  id: string;
  url: string;
  hash: string;
  shingles: number[];
  code: boolean;
}

const SHINGLE_WORDS = 8;
const MIN_SHINGLES = 5;
const MATCH_RATIO = 0.8;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url;
  }
}

/** FNV-1a 32-bit over a string (fast, good enough for shingle keys). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shinglesOf(text: string): number[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const out: number[] = [];
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++)
    out.push(fnv1a(words.slice(i, i + SHINGLE_WORDS).join(' ')));
  return [...new Set(out)];
}

/** Per-session index: host → seen chunks (by hash and by shingle). */
export class HostBoilerplateIndex {
  private readonly hosts = new Map<
    string,
    { byHash: Map<string, Record[]>; byShingle: Map<number, Record[]>; records: Record[] }
  >();

  /**
   * Judge an incoming page's chunks against what this host has shown on other URLs, then register
   * the page's kept chunks. Chunks are judged before registration so a page never matches itself.
   */
  judge(url: string, chunks: BoilerplateChunk[]): BoilerplateVerdict {
    const host = hostOf(url);
    let h = this.hosts.get(host);
    if (!h) {
      h = { byHash: new Map(), byShingle: new Map(), records: [] };
      this.hosts.set(host, h);
    }
    const drop = new Set<string>();
    const retract = new Set<string>();
    const incoming: Record[] = chunks.map((c) => ({
      id: c.id,
      url: c.url,
      hash: c.contentHash,
      shingles: shinglesOf(c.text),
      code: /```/.test(c.text),
    }));
    let matches = 0;
    const matchedEarlier: Record[][] = [];
    for (const rec of incoming) {
      const earlier: Record[] = [];
      for (const e of h.byHash.get(rec.hash) ?? []) if (e.url !== rec.url) earlier.push(e);
      if (!earlier.length && rec.shingles.length >= MIN_SHINGLES) {
        const overlap = new Map<Record, number>();
        for (const s of rec.shingles)
          for (const e of h.byShingle.get(s) ?? []) {
            if (e.url === rec.url) continue;
            overlap.set(e, (overlap.get(e) ?? 0) + 1);
          }
        for (const [e, n] of overlap)
          if (n >= MATCH_RATIO * rec.shingles.length && n >= MATCH_RATIO * e.shingles.length)
            earlier.push(e);
      }
      if (earlier.length) matches++;
      matchedEarlier.push(earlier);
    }
    const duplicatePage = incoming.length >= 3 && matches >= MATCH_RATIO * incoming.length;
    incoming.forEach((rec, i) => {
      const earlier = matchedEarlier[i] as Record[];
      if (earlier.length && !rec.code) {
        drop.add(rec.id);
        if (!duplicatePage) for (const e of earlier) if (!e.code) retract.add(e.id);
      }
    });
    // Register kept chunks (dropped ones are boilerplate — the earlier copy already indexes it).
    for (const rec of incoming) {
      if (drop.has(rec.id)) continue;
      h.records.push(rec);
      const list = h.byHash.get(rec.hash) ?? [];
      list.push(rec);
      h.byHash.set(rec.hash, list);
      for (const s of rec.shingles) {
        const l = h.byShingle.get(s) ?? [];
        l.push(rec);
        h.byShingle.set(s, l);
      }
    }
    return { drop, retract, duplicatePage };
  }
}
