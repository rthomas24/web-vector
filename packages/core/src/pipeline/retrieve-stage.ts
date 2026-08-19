/**
 * Stage 4: hybrid retrieval over a session's chunks.
 *
 *   query vectors (original + expansions + pseudo-document) → vector top-k lists
 *   query strings                                            → BM25 top-k lists
 *   → weighted RRF fusion → cosine cutoffs → near-duplicate removal → per-source cap
 *   → MMR diversity → optional reranker → top-k passages
 *
 * Works with no embedder at all (lexical-only mode) and degrades to lexical when embedding fails.
 */
import type { WebVectorFileConfig } from '../config/index.js';
import { WebVectorError } from '../errors.js';
import { tokenize } from '../retrieval/bm25.js';
import {
  autocut,
  dedupeChunks,
  diversifyBySource,
  groupAdjacent,
  joinAdjacentText,
  minMaxNormalize,
  mmr,
  type Ranked,
  rrf,
  scoreFusion,
  shingleJaccard,
  xquad,
} from '../retrieval/fusion.js';
import { leadWindow, rankHighlightWindows, toHighlight } from '../retrieval/highlight.js';
import {
  BUILTIN_SOURCE_PRIORS,
  compileSourcePriors,
  isPrimaryFor,
  sourcePriorFor,
} from '../retrieval/priors.js';
import type { MemoryVectorStore } from '../stores/memory.js';
import type { Freshness, Passage, PassageExplain, ScoredChunk, SearchResult } from '../types.js';
import { combine, dot } from '../util/vector.js';
import type { Components } from './components.js';
import { citationFor } from './format.js';
import type { Session } from './session.js';

export interface RetrieveInput {
  session: Session;
  /** The user's query (first) followed by related/expanded queries. */
  queries: string[];
  /** Queries supplied by the caller (weighted higher than heuristic expansions). */
  relatedQueries: string[];
  /** Search results, used to build a pseudo-document vector from top snippets. */
  searchResults: SearchResult[];
  topK: number;
  /** Per-call override of the configured reranker on/off. */
  rerank?: boolean;
  signal?: AbortSignal;
  warnings: string[];
  /** Attach `Passage.explain` breakdowns. */
  explain?: boolean;
  /** Compute `Passage.highlight` (best sentence window per passage). Default true. */
  highlights?: boolean;
  /** Caller's freshness request; enables the recency boost (`retrieval.recency`). */
  freshness?: Freshness;
}

export interface RetrieveOutput {
  passages: Passage[];
  candidates: number;
  reranked: boolean;
  /** True when no vectors were used (configured lexical mode or embedding failure). */
  lexicalOnly: boolean;
  /** Passages per related query (aspect) when aspect coverage ran. */
  coverage?: Record<string, number>;
  /** Inputs for the evidence gate. */
  signals: { topScoreRatio: number; cutoffPosition: number };
}

type Candidate = ScoredChunk & {
  fused: number;
  /** xQuAD objective value at selection time (aspect coverage mode). */
  aspectScore?: number;
  /** Score multipliers applied to `fused` (recency, corroboration, source priors) — for explain. */
  multipliers?: Record<string, number>;
  /** Distinct registrable domains whose candidate chunks corroborate this one (incl. its own). */
  corroboration?: number;
  /** Set on a passage assembled from neighbouring chunks (see `mergeAdjacentCandidates`). */
  parts?: Candidate[];
};

export async function runRetrieveStage(
  c: Components,
  rc: WebVectorFileConfig['retrieval'],
  input: RetrieveInput,
): Promise<RetrieveOutput> {
  const { session, queries, relatedQueries, searchResults, topK, signal, warnings } = input;
  const query = queries[0] as string;
  const candidateK = Math.max(topK * rc.candidateMultiplier, topK + 10);
  // A long page can fill every candidate slot of a ranked list on its own (a 150-chunk article vs
  // a 2-chunk paper), starving other sources before fusion ever sees them. Over-fetch each list and
  // keep at most `perSourceCandidates` chunks per source, so every source can compete.
  const perSourceCandidates = Math.max(rc.maxPerSource * 2, 6);
  const overFetchK = candidateK * 3;
  const sourceOf = (id: string) =>
    hitById.get(id)?.metadata.canonicalUrl ?? session.chunks.get(id)?.metadata.canonicalUrl ?? id;
  const capPerSource = <T extends { id: string }>(hits: T[]): T[] => {
    const seen = new Map<string, number>();
    const out: T[] = [];
    for (const h of hits) {
      const src = sourceOf(h.id);
      const n = seen.get(src) ?? 0;
      if (n >= perSourceCandidates) continue;
      seen.set(src, n + 1);
      out.push(h);
      if (out.length >= candidateK) break;
    }
    return out;
  };

  const lists: Ranked[][] = [];
  const weights: number[] = [];
  const listQuery: string[] = []; // which query produced each list (→ passage.matchedQueries)
  const listKind: ('bm25' | 'vector')[] = [];
  const cosineBest = new Map<string, number>();
  const bm25Best = new Map<string, number>();
  const hitById = new Map<string, ScoredChunk>();
  let queryVector: Float32Array | undefined;
  let lexicalOnly = !c.embedder;

  // ── vector lists ─────────────────────────────────────────────────────
  if (c.embedder) {
    try {
      const qvecs = await c.embedder.embed(queries, { kind: 'query', signal });
      queryVector = qvecs[0];
      const vectors = qvecs.map((v, i) => ({
        v,
        w: i === 0 ? 1 : relatedQueries.includes(queries[i] as string) ? 0.85 : rc.expansionWeight,
        q: queries[i] as string,
      }));
      const pseudo = await pseudoDocumentVector(c, queryVector, searchResults, signal);
      if (pseudo) vectors.push({ v: pseudo, w: 0.6, q: query });

      const results = await Promise.all(
        vectors.map((qv) =>
          session.store.query(qv.v, { topK: overFetchK, sessionId: session.id, signal }),
        ),
      );
      results.forEach((raw, i) => {
        for (const h of raw) if (!hitById.has(h.id)) hitById.set(h.id, h);
        const hits = capPerSource(raw);
        lists.push(hits.map((h) => ({ id: h.id, score: h.score })));
        weights.push(vectors[i]!.w);
        listQuery.push(vectors[i]!.q);
        listKind.push('vector');
        for (const h of hits) {
          if (!hitById.has(h.id)) hitById.set(h.id, h);
          if ((cosineBest.get(h.id) ?? Number.NEGATIVE_INFINITY) < h.score)
            cosineBest.set(h.id, h.score);
        }
      });
    } catch (err) {
      const e = WebVectorError.from(err, { code: 'EMBEDDING_FAILED', stage: 'retrieve' });
      if (!rc.fallbackToLexical) throw e;
      warnings.push(
        `Vector retrieval unavailable (${e.code}: ${e.message}); using lexical retrieval only.`,
      );
      lexicalOnly = true;
    }
  }

  // ── lexical lists (hybrid or lexical-only) ───────────────────────────
  const lexicalWeight = rc.lexicalWeight * (rc.adaptiveWeights ? lexicalAffinity(query) : 1);
  if (rc.hybrid || lexicalOnly) {
    queries.forEach((q, i) => {
      const hits = capPerSource(
        session.bm25.search(q, overFetchK, (id) => {
          const ch = session.chunks.get(id);
          return !ch || ch.metadata.sessionId === session.id;
        }),
      );
      if (hits.length === 0) return;
      lists.push(hits);
      const base = i === 0 ? 1 : 0.7;
      weights.push(lexicalOnly ? base : lexicalWeight * base);
      listQuery.push(q);
      listKind.push('bm25');
      for (const h of hits) if ((bm25Best.get(h.id) ?? 0) < h.score) bm25Best.set(h.id, h.score);
    });
  }
  if (lists.length === 0)
    return {
      passages: [],
      candidates: 0,
      reranked: false,
      lexicalOnly,
      signals: { topScoreRatio: 0, cutoffPosition: 0 },
    };

  // SERP prior: the engine's ordering as one more list over the current candidates.
  if (rc.serpPriorWeight > 0) {
    const ids = new Set<string>();
    for (const l of lists) for (const h of l) ids.add(h.id);
    const prior: Ranked[] = [];
    for (const id of ids) {
      const rank =
        hitById.get(id)?.metadata.searchRank ?? session.chunks.get(id)?.metadata.searchRank;
      if (rank) prior.push({ id, score: 1 / rank });
    }
    if (prior.length) {
      prior.sort((a, b) => b.score - a.score);
      lists.push(prior);
      weights.push(rc.serpPriorWeight);
      listQuery.push(query);
      listKind.push('bm25'); // treated as a lexical-side signal for explain purposes
    }
  }

  // Best BM25 score per chunk relative to the top of its list (scale-free, like the cosine
  // `relativeCutoff`; raw BM25 magnitudes vary per query).
  const lexRel = new Map<string, number>();
  lists.forEach((l, li) => {
    if (listKind[li] !== 'bm25' || l.length === 0) return;
    const top = l[0]!.score || 1;
    for (const h of l) {
      const r = h.score / top;
      if ((lexRel.get(h.id) ?? 0) < r) lexRel.set(h.id, r);
    }
  });

  // ── fuse ─────────────────────────────────────────────────────────────
  const fused =
    rc.fusion === 'rsf' ? scoreFusion(lists, weights) : rrf(lists, { k: rc.rrfK, weights });
  const matched = new Map<string, Set<string>>();
  lists.forEach((l, li) => {
    for (const h of l) {
      let s = matched.get(h.id);
      if (!s) {
        s = new Set();
        matched.set(h.id, s);
      }
      s.add(listQuery[li] as string);
    }
  });
  let cands: Candidate[] = [];
  for (const f of fused) {
    const chunk = hitById.get(f.id) ?? session.chunks.get(f.id);
    if (!chunk) continue;
    const vector =
      chunk.vector ??
      session.chunks.get(f.id)?.vector ??
      (session.store as MemoryVectorStore).get?.(f.id)?.vector;
    cands.push({ ...chunk, vector, score: cosineBest.get(f.id) ?? 0, fused: f.score });
  }
  const candidates = cands.length;
  // Every fusion candidate (before cutoffs/dedupe): corroboration is counted against these, since
  // near-duplicate removal is exactly what deletes the corroborating copies.
  const allCands = cands.slice();

  // ── filter: cosine cutoffs (when vectors exist) or lexical relative cutoff, then near-duplicates ──
  if (!lexicalOnly && cosineBest.size) {
    const top = Math.max(...cands.map((x) => x.score));
    cands = cands.filter((x) => {
      const cos = cosineBest.get(x.id);
      if (cos === undefined) return true; // lexical-only hit
      if (rc.minScore !== null && cos < rc.minScore) return false;
      return !(rc.relativeCutoff > 0 && top > 0 && cos < rc.relativeCutoff * top);
    });
  } else if (rc.lexicalRelativeCutoff > 0) {
    // Lexical mode: drop chunks whose best normalised BM25 score is far below the best hit, so a
    // query with one good page doesn't pad top-k with noise.
    cands = cands.filter((x) => (lexRel.get(x.id) ?? 0) >= rc.lexicalRelativeCutoff);
  }
  cands = dedupeChunks(cands, rc.nearDuplicateThreshold);

  // ── score multipliers: recency (only with a freshness request), corroboration (opt-in) ──
  const boost = (x: Candidate, name: string, m: number) => {
    if (m === 1) return;
    x.fused *= m;
    x.multipliers ??= {};
    x.multipliers[name] = round(m, 3);
  };
  if (input.freshness && rc.recency.weight > 0) {
    const halfLife = recencyHalfLifeDays(input.freshness, rc.recency.halfLifeDays);
    for (const x of cands)
      boost(x, 'recency', recencyBoost(x.metadata.publishedAt, halfLife, rc.recency.weight));
  }
  // Source-authority priors (glob → multiplier, tiny built-ins + user overrides) and preferPrimary
  // (the page's domain names something in the query → likely the primary source).
  const priors = compileSourcePriors(
    rc.sourcePriors,
    rc.builtinSourcePriors ? BUILTIN_SOURCE_PRIORS : {},
  );
  if (priors.length || rc.preferPrimary) {
    for (const x of cands) {
      const sp = sourcePriorFor(x.metadata.url, priors);
      if (sp.multiplier !== 1) boost(x, 'sourcePrior', sp.multiplier);
      if (rc.preferPrimary && isPrimaryFor(x.metadata.url, query, registrableDomain))
        boost(x, 'preferPrimary', rc.preferPrimaryBoost);
    }
  }
  const corroborationOf = corroborationCounter(allCands, rc.corroborationJaccard);
  if (rc.corroborationBoost) {
    // Pairwise text similarity is O(n²): only the top slice of candidates competes for a boost.
    for (const x of cands.slice(0, 80)) {
      x.corroboration = corroborationOf(x);
      boost(x, 'corroboration', 1 + 0.1 * Math.min(x.corroboration - 1, 3));
    }
  }
  cands.sort((a, b) => b.fused - a.fused);

  // ── diversify → rerank → cut ─────────────────────────────────────────
  const poolK = Math.max(topK * 2, rc.rerankTopN);
  let pool = diversifyBySource(cands, rc.maxPerSource, poolK);
  if (rc.maxPerDomain > 0) pool = capPerDomain(pool, rc.maxPerDomain);
  if (rc.mmr && pool.length > 1) {
    const canUseVectors = !!queryVector && !lexicalOnly && pool.every((p) => p.vector);
    if (canUseVectors && rc.mmrSimilarity !== 'jaccard') {
      pool = mmr(queryVector, pool, poolK, rc.mmrLambda);
    } else {
      // Lexical MMR: relevance = min-max normalised fused score, redundancy = word-3-gram Jaccard.
      const rel = minMaxNormalize(pool.map((p) => ({ id: p.id, score: p.fused }))).map(
        (r) => r.score,
      );
      pool = mmr(undefined, pool, poolK, rc.mmrLambda, { relevance: rel });
    }
  }
  // Aspect coverage (xQuAD-lite): with caller-supplied related queries, each one is an aspect;
  // re-select the top-k from the pool so every sub-question gets a passage before any gets a third.
  const aspects = rc.aspectCoverage === 'off' ? [] : relatedQueries.filter((q) => q !== query);
  let coverage: Record<string, number> | undefined;
  if (aspects.length && pool.length > 1) {
    const relOfList = new Map<number, Map<string, number>>(); // list index → id → min-max score
    lists.forEach((l, li) => {
      if (!aspects.includes(listQuery[li] as string)) return;
      relOfList.set(li, new Map(minMaxNormalize(l).map((h) => [h.id, h.score])));
    });
    const relFor = (id: string, aspect: string): number => {
      let best = 0;
      relOfList.forEach((m, li) => {
        if (listQuery[li] !== aspect) return;
        const r = m.get(id) ?? 0;
        if (r > best) best = r;
      });
      return best;
    };
    const relevance = minMaxNormalize(pool.map((p) => ({ id: p.id, score: p.fused }))).map(
      (r) => r.score,
    );
    const { items, scores } = xquad(
      pool,
      relevance,
      aspects.map((a) => ({ weight: 1, rel: pool.map((p) => relFor(p.id, a)) })),
      pool.length,
      rc.aspectLambda,
    );
    pool = items.map((p, i) => ({ ...p, aspectScore: scores[i] as number }));
    coverage = Object.fromEntries(aspects.map((a) => [a, 0]));
  }
  let reranked = false;
  if ((input.rerank ?? !!c.reranker) && c.reranker && pool.length > 1) {
    try {
      const top = await c.reranker.rerank(query, pool.slice(0, rc.rerankTopN), {
        topN: topK,
        signal,
      });
      const rest = pool.filter((p) => !top.some((x) => x.id === p.id));
      pool = [...(top as Candidate[]), ...rest];
      reranked = true;
    } catch (err) {
      warnings.push(
        `Reranker ${c.reranker.id} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // MMR/diversification decide *which* chunks make the cut; display order is by score.
  let cut: Candidate[] = pool.slice(0, topK);
  const rankScore = (x: Candidate) =>
    reranked && x.rerankScore !== undefined ? x.rerankScore : (x.aspectScore ?? x.fused);
  // Neighbouring chunks of one page (answers straddling a chunk boundary) come back as a single
  // passage; the freed slots are backfilled from the pool so the caller still gets ~topK passages.
  if (rc.mergeAdjacent) cut = mergeAdjacentCandidates(cut, pool, topK, rc.maxPerSource, rankScore);
  const norm = minMaxNormalize(cut.map((x) => ({ id: x.id, score: rankScore(x) })));
  const normById = new Map(norm.map((n) => [n.id, n.score]));
  cut.sort((a, b) => (normById.get(b.id) ?? 0) - (normById.get(a.id) ?? 0));
  if (rc.autocut > 0 && cut.length > 1) {
    const keep = autocut(
      cut.map((x) => normById.get(x.id) ?? 0),
      rc.autocut,
      { minKeep: Math.min(3, cut.length) },
    );
    cut.splice(keep);
  }

  const poolRank = new Map(pool.map((p, i) => [p.id, i + 1]));
  const explainFor = (id: string, x: Candidate): PassageExplain => {
    const entries: PassageExplain['lists'] = [];
    lists.forEach((l, li) => {
      const r = l.findIndex((h) => h.id === id);
      if (r >= 0)
        entries.push({
          kind: listKind[li] as 'bm25' | 'vector',
          query: listQuery[li] as string,
          rank: r + 1,
          score: round(l[r]!.score),
          weight: weights[li] as number,
        });
    });
    const best = (kind: 'bm25' | 'vector') =>
      entries
        .filter((e) => e.kind === kind)
        .reduce<number | undefined>(
          (m, e) => (m === undefined || e.rank < m ? e.rank : m),
          undefined,
        );
    return {
      fused: round(reranked && x.rerankScore !== undefined ? x.rerankScore : x.fused, 6),
      bm25Rank: best('bm25'),
      vectorRank: best('vector'),
      poolRank: poolRank.get(id) ?? 0,
      lists: entries,
      ...(x.parts ? { mergedChunks: x.parts.map((p) => p.metadata.chunkIndex) } : {}),
      ...(x.aspectScore !== undefined ? { aspectScore: round(x.aspectScore, 6) } : {}),
      ...(x.multipliers ? { multipliers: x.multipliers } : {}),
    };
  };

  const passages: Passage[] = cut.map((x, i) => {
    const cos = cosineBest.get(x.id);
    return {
      index: i + 1,
      text: x.text,
      url: x.metadata.url,
      title: x.metadata.title,
      score: round((normById.get(x.id) ?? 0) * 0.9 + 0.1),
      cosine: cos === undefined ? undefined : round(cos),
      bm25: bm25Best.has(x.id) ? round(bm25Best.get(x.id) as number, 3) : undefined,
      rerankScore: x.rerankScore === undefined ? undefined : round(x.rerankScore),
      chunkIndex: x.metadata.chunkIndex,
      ...(x.parts ? { chunkCount: x.parts.length } : {}),
      startOffset: x.metadata.startOffset,
      endOffset: x.metadata.endOffset,
      siteName: x.metadata.siteName,
      publishedAt: x.metadata.publishedAt,
      fetchedAt: x.metadata.fetchedAt,
      matchedQueries: matchedFor(x, matched, query),
      corroboration: x.corroboration ?? corroborationOf(x),
      citation: citationFor(i + 1, x.metadata.title, x.metadata.url, x.metadata.publishedAt),
      ...(input.explain ? { explain: explainFor(x.id, x) } : {}),
    };
  });
  if (input.highlights !== false)
    await attachHighlights(c, session, passages, query, relatedQueries, {
      queryVector: lexicalOnly ? undefined : queryVector,
      signal,
    });
  if (coverage) {
    for (const p of passages)
      for (const q of p.matchedQueries) if (q in coverage) coverage[q] = (coverage[q] ?? 0) + 1;
  }
  // Evidence signals: how peaked the fused distribution is (top passage vs mean candidate) and how
  // many of the requested slots survived the cutoffs.
  const meanFused = allCands.reduce((a, x) => a + x.fused, 0) / Math.max(1, allCands.length);
  const signals = {
    topScoreRatio: cut.length && meanFused > 0 ? rankScore(cut[0] as Candidate) / meanFused : 0,
    cutoffPosition: passages.length / Math.max(1, topK),
  };
  return { passages, candidates, reranked, lexicalOnly, coverage, signals };
}

/**
 * Query-focused highlights: idf-weighted term coverage picks the best 1–3 sentence window of each
 * passage (related-query terms at half weight). With an embedder, the top-3 lexical windows of
 * every passage are embedded in one batch and cosine to the query vector breaks near-ties.
 */
async function attachHighlights(
  c: Components,
  session: Session,
  passages: Passage[],
  query: string,
  relatedQueries: string[],
  opts: { queryVector?: Float32Array; signal?: AbortSignal },
): Promise<void> {
  const terms = new Map<string, number>();
  const weigh = (q: string, w: number) => {
    for (const t of new Set(tokenize(q))) {
      const v = w * Math.max(0.5, session.bm25.idf(t) || 1);
      if ((terms.get(t) ?? 0) < v) terms.set(t, v);
    }
  };
  weigh(query, 1);
  for (const q of relatedQueries) weigh(q, 0.5);
  if (terms.size === 0) return;
  const useCosine = !!(c.embedder && opts.queryVector);
  const perPassage = passages.map((p) =>
    p.fromSnippet ? [] : rankHighlightWindows(p.text, { terms, top: useCosine ? 3 : 1 }),
  );
  if (useCosine) {
    // One batch for all windows; failures just leave the lexical choice in place.
    const flat = perPassage.flat();
    try {
      const vecs = await (c.embedder as NonNullable<Components['embedder']>).embed(
        flat.map((w) => w.text),
        { kind: 'document', signal: opts.signal },
      );
      flat.forEach((w, i) => {
        const v = vecs[i];
        if (v) w.score += 0.3 * dot(opts.queryVector as Float32Array, v);
      });
      for (const wins of perPassage) wins.sort((a, b) => b.score - a.score);
    } catch {
      /* lexical highlight stands */
    }
  }
  passages.forEach((p, i) => {
    let w = perPassage[i]?.[0];
    if (!w) return;
    if (w.coverage <= 0) w = leadWindow(p.text, { terms }) ?? w;
    p.highlight = toHighlight(w, p.startOffset);
  });
}

/**
 * Merge neighbouring chunks of the same page (chunkIndex ±1) among the selected candidates into one
 * candidate whose text spans both (overlap removed via page offsets). The merged item keeps the id
 * and scores of its best-scoring part, so score/explain lookups keep working. A merged passage
 * counts once toward `maxPerSource`, so freed slots are backfilled from `pool` (which may in turn
 * create new neighbours — hence the small loop).
 */
function mergeAdjacentCandidates(
  cut: Candidate[],
  pool: Candidate[],
  topK: number,
  maxPerSource: number,
  rankScore: (x: Candidate) => number,
): Candidate[] {
  let selected = cut;
  for (let round = 0; round < 3; round++) {
    // Work on the flat chunks so a backfilled neighbour can join an already-merged group.
    const groups = groupAdjacent(selected.flatMap((x) => x.parts ?? [x]));
    selected = groups.map((parts) => {
      if (parts.length === 1) return parts[0] as Candidate;
      const best = parts.reduce((m, x) => (rankScore(x) > rankScore(m) ? x : m));
      const first = parts[0] as Candidate;
      let acc: Candidate = first;
      for (const p of parts.slice(1)) {
        acc = {
          ...acc,
          text: joinAdjacentText(acc, p),
          metadata: {
            ...acc.metadata,
            endOffset: Math.max(acc.metadata.endOffset, p.metadata.endOffset),
          },
        };
      }
      const text = acc.text;
      return {
        ...best,
        text,
        parts,
        metadata: {
          ...best.metadata,
          chunkIndex: first.metadata.chunkIndex,
          startOffset: first.metadata.startOffset,
          endOffset: Math.max(...parts.map((p) => p.metadata.endOffset)),
        },
      };
    });
    if (selected.length >= topK) break;
    // Backfill: next pool items not already used, honouring the per-source cap (merged = 1).
    const used = new Set(selected.flatMap((x) => (x.parts ?? [x]).map((p) => p.id)));
    const perSource = new Map<string, number>();
    for (const x of selected)
      perSource.set(x.metadata.canonicalUrl, (perSource.get(x.metadata.canonicalUrl) ?? 0) + 1);
    let added = 0;
    for (const p of pool) {
      if (selected.length >= topK) break;
      if (used.has(p.id)) continue;
      const n = perSource.get(p.metadata.canonicalUrl) ?? 0;
      if (n >= maxPerSource) continue;
      perSource.set(p.metadata.canonicalUrl, n + 1);
      used.add(p.id);
      selected.push(p);
      added++;
    }
    if (added === 0) break;
  }
  return selected;
}

/** Half-life for the recency boost implied by a freshness request. */
export function recencyHalfLifeDays(freshness: Freshness, fallback: number): number {
  switch (freshness) {
    case 'day':
      return 2;
    case 'week':
      return 7;
    case 'month':
      return 30;
    case 'year':
      return 180;
    default:
      return fallback;
  }
}

/**
 * Exponential-decay recency multiplier: 1 + w·0.5^(ageDays/halfLife), capped at 1.3. Undated
 * pages get exactly 1 (never penalised); future dates count as age 0.
 */
export function recencyBoost(
  publishedAt: string | undefined,
  halfLifeDays: number,
  weight: number,
  now = Date.now(),
): number {
  if (!publishedAt) return 1;
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return 1;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.min(1.3, 1 + weight * 0.5 ** (ageDays / Math.max(1, halfLifeDays)));
}

/**
 * Corroboration = number of distinct registrable domains (including the chunk's own) whose
 * candidate chunks say the same thing: word-3-gram Jaccard ≥ `minJaccard`, or cosine ≥ 0.85 when
 * both chunks have vectors. Shingle sets are computed lazily and cached per candidate.
 */
function corroborationCounter(cands: Candidate[], minJaccard: number): (x: Candidate) => number {
  const cache = new Map<string, number>();
  const domain = new Map<string, string>();
  const domainOf = (x: Candidate) => {
    let d = domain.get(x.id);
    if (!d) {
      d = registrableDomain(x.metadata.url);
      domain.set(x.id, d);
    }
    return d;
  };
  return (x: Candidate) => {
    const hit = cache.get(x.id);
    if (hit !== undefined) return hit;
    const domains = new Set<string>([domainOf(x)]);
    for (const o of cands) {
      if (o.id === x.id) continue;
      const d = domainOf(o);
      if (domains.has(d)) continue;
      const cos = x.vector && o.vector ? dot(x.vector, o.vector) : 0;
      if (cos >= 0.85 || shingleJaccard(x.text, o.text, 3) >= minJaccard) domains.add(d);
    }
    cache.set(x.id, domains.size);
    return domains.size;
  };
}

/** matchedQueries of a passage = union over its merged parts (or the chunk itself). */
function matchedFor(x: Candidate, matched: Map<string, Set<string>>, query: string): string[] {
  const out = new Set<string>();
  for (const p of x.parts ?? [x]) for (const q of matched.get(p.id) ?? []) out.add(q);
  return out.size ? [...out] : [query];
}

/** Registrable-ish domain (last two labels, three for common ccSLDs like co.uk). */
export function registrableDomain(url: string): string {
  try {
    const parts = new URL(url).hostname.toLowerCase().split('.');
    if (parts.length <= 2) return parts.join('.');
    const sld = parts[parts.length - 2] as string;
    const ccSld = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'or', 'ne']);
    const n = ccSld.has(sld) && (parts[parts.length - 1] as string).length === 2 ? 3 : 2;
    return parts.slice(-n).join('.');
  } catch {
    return url;
  }
}

/**
 * Prefer at most `max` items per registrable domain: items beyond the cap are moved behind every
 * other domain's items (not dropped), so single-domain result sets are unaffected.
 */
function capPerDomain<T extends { metadata: { url: string } }>(items: T[], max: number): T[] {
  const seen = new Map<string, number>();
  const kept: T[] = [];
  const overflow: T[] = [];
  for (const it of items) {
    const d = registrableDomain(it.metadata.url);
    const n = seen.get(d) ?? 0;
    if (n >= max) overflow.push(it);
    else {
      seen.set(d, n + 1);
      kept.push(it);
    }
  }
  return kept.concat(overflow);
}

/**
 * How much a query rewards exact lexical matching: >1 for quotes, code identifiers, versions,
 * error strings and several proper nouns (embeddings blur these); <1 for long natural-language
 * questions (embeddings shine there).
 */
export function lexicalAffinity(query: string): number {
  const q = query.trim();
  let f = 1;
  if (/"[^"]{2,}"/.test(q)) f *= 1.6;
  const identifiers = q.match(
    /[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z]+|--?[a-z][\w-]+/g,
  );
  if (identifiers?.length) f *= 1.4;
  if (/\b\d+(\.\d+)+\b|\bv\d+\b|\b(19|20)\d{2}\b/.test(q)) f *= 1.2;
  if (/\b(error|exception|failed|cannot|undefined is not|ENOENT|E[A-Z]{3,})\b/.test(q)) f *= 1.3;
  const proper = q.split(/\s+/).filter((w, i) => i > 0 && /^[A-Z][a-z]+$/.test(w)).length;
  if (proper >= 2) f *= 1.2;
  const words = q.split(/\s+/).length;
  if (words >= 8 && /^(why|how|what|when|which|explain|describe|compare)\b/i.test(q) && f === 1)
    f = 0.75;
  return Math.min(f, 2.5);
}

/** Blend the query vector with the top search snippets (pseudo-relevance feedback). */
async function pseudoDocumentVector(
  c: Components,
  queryVector: Float32Array | undefined,
  searchResults: SearchResult[],
  signal?: AbortSignal,
): Promise<Float32Array | undefined> {
  if (!c.embedder || !queryVector) return undefined;
  const snippets = searchResults
    .slice(0, 3)
    .map((r) => r.snippet)
    .filter((s): s is string => !!s && s.length > 30);
  if (snippets.length === 0) return undefined;
  try {
    const sv = await c.embedder.embed(snippets, { kind: 'document', signal });
    return combine([{ v: queryVector, w: 0.7 }, ...sv.map((v) => ({ v, w: 0.3 / sv.length }))]);
  } catch {
    return undefined;
  }
}

function round(n: number, digits = 4): number {
  return Number(n.toFixed(digits));
}
