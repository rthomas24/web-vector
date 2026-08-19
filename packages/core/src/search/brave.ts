import type { SearchCapabilities, SearchOptions, SearchProvider, SearchResult } from '../types.js';
import { qs, requestJson } from '../util/http.js';
import {
  type BaseSearchOptions,
  KEYLESS_HINT,
  mapFreshness,
  normalizeResults,
  requireApiKey,
} from './base.js';

/** Brave Search API — https://api.search.brave.com/res/v1/web/search (X-Subscription-Token). */
export class BraveSearch implements SearchProvider {
  readonly id = 'brave';
  private readonly key: string;
  constructor(private readonly opts: BaseSearchOptions = {}) {
    this.key = requireApiKey(
      'Brave Search',
      opts.apiKey ?? process.env.BRAVE_API_KEY,
      ['BRAVE_API_KEY'],
      'search.apiKey',
      KEYLESS_HINT,
    );
  }
  capabilities(): SearchCapabilities {
    return {
      requiresApiKey: true,
      keyless: false,
      maxResults: 20,
      supportsFreshness: true,
      supportsDomainFilter: false,
      supportsSafeSearch: true,
      supportsCountry: true,
      supportsLanguage: true,
    };
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const freshness =
      typeof opts.freshness === 'object' && opts.freshness
        ? `${opts.freshness.after ?? '2000-01-01'}to${opts.freshness.before ?? new Date().toISOString().slice(0, 10)}`
        : mapFreshness(opts.freshness, { day: 'pd', week: 'pw', month: 'pm', year: 'py' });
    const url = `${this.opts.baseUrl ?? 'https://api.search.brave.com/res/v1/web/search'}${qs({
      q: query.slice(0, 400),
      count: Math.min(opts.count ?? 10, 20),
      country: opts.country?.toUpperCase(),
      search_lang: opts.language,
      safesearch: opts.safeSearch ?? 'moderate',
      freshness,
      text_decorations: false,
      extra_snippets: true,
      result_filter: 'web',
      ...(this.opts.options as Record<string, string> | undefined),
    })}`;
    const json = await requestJson<any>(url, {
      provider: this.id,
      headers: { 'X-Subscription-Token': this.key, 'accept-encoding': 'gzip' },
      timeoutMs: this.opts.timeoutMs,
      signal: opts.signal,
    });
    const items: any[] = json?.web?.results ?? [];
    const raw: SearchResult[] = items.map((r, i) => ({
      url: r.url,
      title: r.title,
      snippet: r.description,
      rank: i + 1,
      publishedAt: r.page_age ?? undefined,
      source: this.id,
      extra: {
        extraSnippets: r.extra_snippets,
        age: r.age,
        language: r.language,
        siteName: r.profile?.name ?? r.meta_url?.hostname,
      },
    }));
    return normalizeResults(raw, opts);
  }
}
