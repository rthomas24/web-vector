import type { LlmFn, QueryExpander, SearchResult } from '../types.js';
import { BM25Index, tokenize } from './bm25.js';

/**
 * Heuristic (no-LLM) query expansion:
 *  1. keyword-only form of the query;
 *  2. pseudo-relevance feedback (RM3-style): query + top tf-idf terms from top-5 titles/snippets;
 *  3. title of the top result as a related phrasing (when it is short and on-topic).
 */
export class HeuristicExpander implements QueryExpander {
  async expand(
    query: string,
    ctx: { searchResults: SearchResult[]; related: string[]; max: number },
  ): Promise<string[]> {
    if (ctx.max <= 0) return [];
    const out: string[] = [];
    const seen = new Set<string>([norm(query), ...ctx.related.map(norm)]);
    const push = (q: string) => {
      const n = norm(q);
      if (!n || seen.has(n) || out.length >= ctx.max) return;
      seen.add(n);
      out.push(q.trim());
    };
    const qTokens = tokenize(query);
    const keyword = qTokens.join(' ');
    if (qTokens.length >= 2 && keyword !== query.toLowerCase().trim()) push(keyword);

    const top = ctx.searchResults.slice(0, 5);
    const texts = top
      .map((r) => `${r.title}. ${r.snippet ?? ''}`)
      .filter((t) => t.trim().length > 5);
    if (texts.length) {
      const terms = BM25Index.topTerms(texts, 6, new Set(qTokens));
      if (terms.length >= 2) push(`${query} ${terms.slice(0, 4).join(' ')}`);
    }
    const title = top[0]?.title;
    if (title && title.length <= 80) {
      const tTok = tokenize(title);
      const overlap = tTok.filter((t) => qTokens.includes(t)).length;
      if (overlap >= 1 && tTok.length >= 3)
        push(title.replace(/\s*[|\-–—]\s*[^|\-–—]*$/, '').trim());
    }
    return out;
  }
}

/** LLM multi-query expansion using a provider-agnostic `LlmFn`. */
export class LlmExpander implements QueryExpander {
  constructor(
    private readonly llm: LlmFn,
    private readonly fallback: QueryExpander = new HeuristicExpander(),
  ) {}
  async expand(
    query: string,
    ctx: { searchResults: SearchResult[]; related: string[]; max: number; signal?: AbortSignal },
  ): Promise<string[]> {
    if (ctx.max <= 0) return [];
    const context = ctx.searchResults
      .slice(0, 5)
      .map((r) => `- ${r.title}${r.snippet ? `: ${r.snippet.slice(0, 160)}` : ''}`)
      .join('\n');
    const prompt = `You generate alternative web search queries for a retrieval system.
Original query: "${query}"
${context ? `Top search results so far:\n${context}\n` : ''}
Write ${ctx.max} diverse, specific search queries that would surface passages answering the original query from different angles (synonyms, sub-questions, a broader "step-back" question, an expected answer phrasing). One per line, no numbering, no quotes, no commentary.`;
    try {
      const text = await this.llm(prompt, { signal: ctx.signal });
      const lines = text
        .split('\n')
        .map((l) =>
          l
            .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
            .replace(/^["']|["']$/g, '')
            .trim(),
        )
        .filter((l) => l.length > 3 && l.length < 200);
      const seen = new Set([norm(query), ...ctx.related.map(norm)]);
      const out: string[] = [];
      for (const l of lines) {
        const n = norm(l);
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(l);
        if (out.length >= ctx.max) break;
      }
      if (out.length) return out;
    } catch {
      /* fall through */
    }
    return this.fallback.expand(query, ctx);
  }
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
