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
import {
  dedupeChunks,
  diversifyBySource,
  minMaxNormalize,
  mmr,
  type Ranked,
  rrf,
} from '../retrieval/fusion.js';
import type { MemoryVectorStore } from '../stores/memory.js';
import type { Passage, PassageExplain, ScoredChunk, SearchResult } from '../types.js';
import { combine } from '../util/vector.js';
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
}

export interface RetrieveOutput {
  passages: Passage[];
  candidates: number;
  reranked: boolean;
  /** True when no vectors were used (configured lexical mode or embedding failure). */
  lexicalOnly: boolean;
}

type Candidate = ScoredChunk & { fused: number };

export async function runRetrieveStage(
  c: Components,
  rc: WebVectorFileConfig['retrieval'],
  input: RetrieveInput,
): Promise<RetrieveOutput> {
  const { session, queries, relatedQueries, searchResults, topK, signal, warnings } = input;
  const query = queries[0] as string;
  const candidateK = Math.max(topK * rc.candidateMultiplier, topK + 10);

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
          session.store.query(qv.v, { topK: candidateK, sessionId: session.id, signal }),
        ),
      );
      results.forEach((hits, i) => {
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
  if (rc.hybrid || lexicalOnly) {
    queries.forEach((q, i) => {
      const hits = session.bm25.search(q, candidateK, (id) => {
        const ch = session.chunks.get(id);
        return !ch || ch.metadata.sessionId === session.id;
      });
      if (hits.length === 0) return;
      lists.push(hits);
      const base = i === 0 ? 1 : 0.7;
      weights.push(lexicalOnly ? base : rc.lexicalWeight * base);
      listQuery.push(q);
      listKind.push('bm25');
      for (const h of hits) if ((bm25Best.get(h.id) ?? 0) < h.score) bm25Best.set(h.id, h.score);
    });
  }
  if (lists.length === 0) return { passages: [], candidates: 0, reranked: false, lexicalOnly };

  // ── fuse ─────────────────────────────────────────────────────────────
  const fused = rrf(lists, { k: rc.rrfK, weights });
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

  // ── filter: cosine cutoffs (only when vectors exist), then near-duplicates ──
  if (!lexicalOnly && cosineBest.size) {
    const top = Math.max(...cands.map((x) => x.score));
    cands = cands.filter((x) => {
      const cos = cosineBest.get(x.id);
      if (cos === undefined) return true; // lexical-only hit
      if (rc.minScore !== null && cos < rc.minScore) return false;
      return !(rc.relativeCutoff > 0 && top > 0 && cos < rc.relativeCutoff * top);
    });
  }
  cands = dedupeChunks(cands, rc.nearDuplicateThreshold);

  // ── diversify → rerank → cut ─────────────────────────────────────────
  const poolK = Math.max(topK * 2, rc.rerankTopN);
  let pool = diversifyBySource(cands, rc.maxPerSource, poolK);
  if (rc.mmr && queryVector && !lexicalOnly) pool = mmr(queryVector, pool, poolK, rc.mmrLambda);
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
  const cut = pool.slice(0, topK);
  const norm = minMaxNormalize(
    cut.map((x) => ({
      id: x.id,
      score: reranked && x.rerankScore !== undefined ? x.rerankScore : x.fused,
    })),
  );
  const normById = new Map(norm.map((n) => [n.id, n.score]));
  cut.sort((a, b) => (normById.get(b.id) ?? 0) - (normById.get(a.id) ?? 0));

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
      startOffset: x.metadata.startOffset,
      endOffset: x.metadata.endOffset,
      siteName: x.metadata.siteName,
      publishedAt: x.metadata.publishedAt,
      fetchedAt: x.metadata.fetchedAt,
      matchedQueries: [...(matched.get(x.id) ?? [query])],
      citation: citationFor(i + 1, x.metadata.title, x.metadata.url),
      ...(input.explain ? { explain: explainFor(x.id, x) } : {}),
    };
  });
  return { passages, candidates, reranked, lexicalOnly };
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
