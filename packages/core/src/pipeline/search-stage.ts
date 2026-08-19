/** Stage 1: run the primary query (and any agent-supplied related queries), merge and filter results. */
import { WebVectorError } from '../errors.js';
import type { Failure, ResearchStats, SearchOptions, SearchResult } from '../types.js';
import { canonicalizeUrl, hostnameOf, matchesDomain } from '../util/url.js';
import type { Components } from './components.js';

export interface SearchStageInput {
  query: string;
  related: string[];
  maxPages: number;
  options: SearchOptions;
  failures: Failure[];
}

export interface SearchStageOutput {
  results: SearchResult[];
  attempts: ResearchStats['search']['attempts'];
}

export async function runSearchStage(
  c: Components,
  input: SearchStageInput,
): Promise<SearchStageOutput> {
  const { query, related, maxPages, options, failures } = input;
  const perRelated = { ...options, count: Math.ceil(maxPages / 2) + 2 };
  const outcomes = await Promise.all(
    [query, ...related].map(async (q, i) => {
      try {
        const results = await c.search.search(q, i === 0 ? options : perRelated);
        return { results, attempts: [...c.search.attempts] };
      } catch (err) {
        if (i === 0) throw err; // primary query failure is fatal
        const e = WebVectorError.from(err, { code: 'SEARCH_FAILED', stage: 'search' });
        failures.push({
          code: e.code,
          message: `related query "${q}": ${e.message}`,
          stage: 'search',
          provider: e.provider,
        });
        return { results: [] as SearchResult[], attempts: [...c.search.attempts] };
      }
    }),
  );
  const merged = mergeSearchResults(outcomes.map((o) => o.results));
  const results = merged.filter((r) => {
    const host = hostnameOf(r.url);
    if (options.domainsAllow?.length && !matchesDomain(host, options.domainsAllow)) return false;
    return !matchesDomain(host, options.domainsBlock);
  });
  return { results, attempts: outcomes.flatMap((o) => o.attempts) };
}

/** Merge result lists from several queries: dedupe by canonical URL, rank by best position (RRF-like). */
export function mergeSearchResults(lists: SearchResult[][]): SearchResult[] {
  const acc = new Map<string, { r: SearchResult; score: number }>();
  lists.forEach((list, li) => {
    const weight = li === 0 ? 1 : 0.8;
    list.forEach((r, i) => {
      const key = canonicalizeUrl(r.url);
      const s = weight / (10 + i);
      const cur = acc.get(key);
      if (!cur) {
        acc.set(key, { r: { ...r }, score: s });
        return;
      }
      cur.score += s;
      if (li === 0 && i < cur.r.rank - 1) cur.r = { ...r };
      if (!cur.r.snippet && r.snippet) cur.r.snippet = r.snippet;
      if (!cur.r.extra?.content && r.extra?.content) cur.r.extra = { ...cur.r.extra, ...r.extra };
    });
  });
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .map((x, i) => ({ ...x.r, rank: i + 1 }));
}
