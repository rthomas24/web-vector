/**
 * Evidence-sufficiency gate (CRAG-lite, no LLM).
 *
 * Deep-research loops all ask the same question after a retrieval call: "is this enough, or should
 * I search again — and for what?" We answer it deterministically from signals the pipeline already
 * has: how much of the query the top passages actually mention, how many independent domains
 * agree, how peaked the score distribution is, and how many slots survived the cutoffs. Suggested
 * follow-up queries come from pseudo-relevance feedback terms and "bridge entities" (capitalised
 * names / code identifiers that the top passages mention but the query does not).
 */
import type { Evidence, Passage } from '../types.js';
import { tokenize } from './bm25.js';

export type EvidenceLevel = Evidence['level'];
export type { Evidence };

export interface EvidenceSignals {
  topScoreRatio: number;
  cutoffPosition: number;
}

const STOP = new Set(
  'a an the and or of to in on for with is are was were be been being by as at it its this that these those from into over under about after before between during without within than then there here how what which who whom whose why when where can could should would will shall may might must do does did done have has had having not no nor so such very just also only own same too more most other some any each few both all if but because while until against up down out off again further once i me my we our you your he him his she her they them their'.split(
    ' ',
  ),
);

/** Strip markdown link targets, raw URLs, HTML tags and citation markers before mining terms. */
function plainText(text: string): string {
  return text
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\?\[\d+\\?\]/g, ' ')
    .replace(/\b\w*cite_(?:note|ref)\S*/g, ' ');
}

/** Surface-form terms (lowercased, unstemmed) so suggestions read like queries, not stems. */
function surfaceWords(text: string): string[] {
  const out: string[] = [];
  for (const m of plainText(text).matchAll(
    /[\p{L}\p{N}][\p{L}\p{N}._-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu,
  )) {
    const w = m[0].toLowerCase();
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(w);
  }
  return out;
}

/** Top tf·idf surface terms across `texts`, excluding anything already in the query. */
export function prfTerms(texts: string[], query: string, n = 3): string[] {
  const exclude = new Set([...surfaceWords(query), ...tokenize(query)]);
  const tf = new Map<string, number>();
  const df = new Map<string, number>();
  for (const t of texts) {
    const seen = new Set<string>();
    for (const w of surfaceWords(t)) {
      if (exclude.has(w) || w.includes('http') || w.includes('www.')) continue;
      tf.set(w, (tf.get(w) ?? 0) + 1);
      if (!seen.has(w)) {
        seen.add(w);
        df.set(w, (df.get(w) ?? 0) + 1);
      }
    }
  }
  const N = Math.max(1, texts.length);
  return [...tf.entries()]
    .map(([w, f]) => ({
      w,
      s: f * Math.log(1 + N / (df.get(w) ?? 1)) * ((df.get(w) ?? 1) > 1 ? 1.5 : 1),
    }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.w);
}

const CAP_BIGRAM_RE = /\b[A-Z][a-z]{2,}(?: [A-Z][a-z]{2,})+\b/g;
const IDENTIFIER_RE =
  /\b[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+\b|\b[a-z]+[A-Z][A-Za-z]+\b|\b[a-z]+_[a-z_]+\b/g;

/**
 * "Bridge entities": capitalised multi-word names and code identifiers that appear in the top
 * passages but not in the query — the things a multi-hop follow-up should name explicitly.
 */
export function bridgeEntities(texts: string[], query: string, n = 3): string[] {
  const q = query.toLowerCase();
  const counts = new Map<string, number>();
  const kind = new Map<string, 'name' | 'code'>();
  const bump = (e: string, k: 'name' | 'code') => {
    if (e.length < 4 || e.length > 60) return;
    if (q.includes(e.toLowerCase())) return;
    if (/\.(?:org|com|net|edu|gov|io|html?|md)$/i.test(e) || /^www\./i.test(e)) return;
    kind.set(e, k);
    if (
      /^(The|This|That|These|Those|When|Where|What|Which|How|Why|Note|See|For|From|With|Also)\b/.test(
        e,
      )
    )
      return;
    counts.set(e, (counts.get(e) ?? 0) + 1);
  };
  for (const t of texts) {
    const plain = plainText(t);
    for (const m of plain.matchAll(CAP_BIGRAM_RE)) bump(m[0], 'name');
    for (const m of plain.matchAll(IDENTIFIER_RE)) {
      const id = m[0];
      if (/^\d/.test(id)) continue;
      bump(id, 'code');
    }
  }
  // Capitalised bigrams also match sentence starts ("Sometimes Queries"): require repetition.
  return [...counts.entries()]
    .filter(([e, n]) => kind.get(e) === 'code' || n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, n)
    .map(([e]) => e);
}

export interface AssessOptions {
  topK: number;
  signals?: EvidenceSignals;
  /** Registrable-domain function (injected to avoid a URL util dependency here). */
  domainOf: (url: string) => string;
  /** Texts to mine for suggestions when there are no passages (e.g. search snippets). */
  fallbackTexts?: string[];
}

/**
 * Score the evidence. Thresholds were set on the bundled golden set (all answerable) so a normal
 * successful call reads `strong`; `weak` = partial term coverage or a single flat-scored source;
 * `none` = nothing returned or the top passages barely mention the query.
 */
export function assessEvidence(query: string, passages: Passage[], opts: AssessOptions): Evidence {
  const top = passages.slice(0, 3);
  const qTerms = [...new Set(tokenize(query))];
  const present = new Set<string>();
  for (const p of top) for (const t of tokenize(p.text)) if (qTerms.includes(t)) present.add(t);
  const coverage = qTerms.length ? present.size / qTerms.length : passages.length ? 1 : 0;
  const distinctDomains = new Set(passages.map((p) => opts.domainOf(p.url))).size;
  const topScoreRatio = opts.signals?.topScoreRatio ?? 0;
  const cutoffPosition = opts.signals?.cutoffPosition ?? passages.length / Math.max(1, opts.topK);

  let level: EvidenceLevel;
  if (passages.length === 0 || coverage < 0.34) level = 'none';
  else if (
    coverage >= 0.67 &&
    (distinctDomains >= 2 || topScoreRatio >= 1.5 || cutoffPosition >= 0.75)
  )
    level = 'strong';
  else level = 'weak';

  const texts = top.length ? top.map((p) => p.text) : (opts.fallbackTexts ?? []);
  const suggested: string[] = [];
  const seen = new Set<string>([query.toLowerCase()]);
  const push = (s: string) => {
    const k = s.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!k || seen.has(k) || suggested.length >= 4) return;
    seen.add(k);
    suggested.push(s.replace(/\s+/g, ' ').trim());
  };
  if (texts.length) {
    const terms = prfTerms(texts, query, 3);
    if (terms.length >= 2) push(`${query} ${terms.join(' ')}`);
    for (const e of bridgeEntities(texts, query, 3)) push(`${query} ${e}`);
  }
  // Query words the top passages never mention are worth searching on their own (surface forms).
  const missing = surfaceWords(query).filter((w) => !tokenize(w).some((t) => present.has(t)));
  if (missing.length && missing.length < qTerms.length) push(`${missing.join(' ')} ${query}`);

  return {
    level,
    coverage: Number(coverage.toFixed(3)),
    distinctDomains,
    topScoreRatio: Number(topScoreRatio.toFixed(3)),
    cutoffPosition: Number(cutoffPosition.toFixed(3)),
    suggestedQueries: suggested,
  };
}
