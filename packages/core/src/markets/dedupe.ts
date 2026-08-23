/**
 * Story dedupe for syndicated news: the same press release or wire story appears on 5–20 sites.
 * Key by canonical URL first (redirect wrappers unwrapped, tracking params stripped), then by a
 * 64-bit SimHash of the normalised title (Hamming ≤ 3) so "Apple Reports Third Quarter Results"
 * on GlobeNewswire, Yahoo and Benzinga collapse into one item whose `spread` counts the distinct
 * sources — a cheap "how widely is this being carried" signal that also down-weights single-source
 * noise. Near-duplicate lookup is banded (four 16-bit bands; Hamming ≤ 3 implies at least one equal
 * band) so it stays linear over a few hundred items.
 */
import { sha256 } from '../util/hash.js';
import { canonicalizeUrl, cleanUrl } from '../util/url.js';
import type { NewsItem } from './types.js';

const STOP = new Set(
  'a an the of to in on for and or as at by is its with from inc corp co ltd plc nyse nasdaq stock stocks shares says report reports update updated breaking'.split(
    ' ',
  ),
);

/** Lower-case word tokens without stop words, punctuation or publisher suffixes (" - CNBC"). */
export function titleTokens(title: string): string[] {
  return title
    .replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/u, '') // trailing " - Publisher"
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}$.%]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
}

/** 64-bit SimHash over word unigrams + bigrams (FNV-1a 64 per feature). */
export function simhash64(tokens: string[]): bigint {
  const v = new Array<number>(64).fill(0);
  const feats = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) feats.push(`${tokens[i]} ${tokens[i + 1]}`);
  for (const f of feats) {
    const h = fnv1a64(f);
    for (let b = 0; b < 64; b++) v[b] = (v[b] as number) + ((h >> BigInt(b)) & 1n ? 1 : -1);
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if ((v[b] as number) > 0) out |= 1n << BigInt(b);
  return out;
}

function fnv1a64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/** Dedupe key for a story URL: redirect wrappers unwrapped, tracking params stripped. */
export function storyKey(url: string): string {
  try {
    return canonicalizeUrl(cleanUrl(url).url);
  } catch {
    return url;
  }
}

export function newsId(url: string | undefined, title: string): string {
  return sha256(url ? storyKey(url) : `title:${titleTokens(title).join(' ')}`).slice(0, 16);
}

export interface DedupeOptions {
  /** Max Hamming distance for near-duplicate titles (default 3). */
  maxDistance?: number;
  /** Source trust by id (higher wins the representative slot). */
  trust?: Record<string, number>;
}

function bands(h: bigint): string[] {
  return [0n, 16n, 32n, 48n].map((s, i) => `${i}:${(h >> s) & 0xffffn}`);
}

/**
 * Collapse duplicates. The representative keeps the earliest `publishedAt`, the URL/summary of the
 * most trusted source, the union of tickers, and `spread` = number of distinct source ids.
 */
export function dedupeNews(items: NewsItem[], opts: DedupeOptions = {}): NewsItem[] {
  const maxD = opts.maxDistance ?? 3;
  const trust = opts.trust ?? {};
  const groups: { rep: NewsItem; hash: bigint; sources: Set<string> }[] = [];
  const byUrl = new Map<string, number>();
  const byBand = new Map<string, number[]>();
  for (const it of items) {
    const tokens = titleTokens(it.title);
    const hash = simhash64(tokens);
    const urlKey = it.url ? storyKey(it.url) : undefined;
    let gi = urlKey !== undefined ? byUrl.get(urlKey) : undefined;
    if (gi === undefined && tokens.length >= 3) {
      const seen = new Set<number>();
      for (const band of bands(hash)) {
        for (const cand of byBand.get(band) ?? []) {
          if (seen.has(cand)) continue;
          seen.add(cand);
          if (hamming((groups[cand] as (typeof groups)[number]).hash, hash) <= maxD) {
            gi = cand;
            break;
          }
        }
        if (gi !== undefined) break;
      }
    }
    if (gi === undefined) {
      gi = groups.length;
      groups.push({
        rep: { ...it, spread: 1, alsoIn: undefined },
        hash,
        sources: new Set([it.source]),
      });
      for (const band of bands(hash)) byBand.set(band, [...(byBand.get(band) ?? []), gi]);
      if (urlKey) byUrl.set(urlKey, gi);
      continue;
    }
    const g = groups[gi] as (typeof groups)[number];
    g.sources.add(it.source);
    if (urlKey) byUrl.set(urlKey, gi);
    const rep = g.rep;
    const better = (trust[it.source] ?? 0.5) > (trust[rep.source] ?? 0.5);
    const earliest =
      it.publishedAt && (!rep.publishedAt || it.publishedAt < rep.publishedAt)
        ? it.publishedAt
        : rep.publishedAt;
    const merged: NewsItem = better
      ? { ...it, id: rep.id, publishedAt: earliest }
      : { ...rep, publishedAt: earliest, summary: rep.summary ?? it.summary };
    merged.tickers = [...new Set([...rep.tickers, ...it.tickers])];
    merged.event = rep.event !== 'other' ? rep.event : it.event;
    g.rep = merged;
  }
  return groups.map((g) => {
    const others = [...g.sources].filter((s) => s !== g.rep.source);
    return { ...g.rep, spread: g.sources.size, alsoIn: others.length ? others : undefined };
  });
}
