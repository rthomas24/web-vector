import type { SearchCapabilities, SearchOptions, SearchProvider, SearchResult } from '../types.js';
import { requestJson } from '../util/http.js';
import {
  type BaseSearchOptions,
  KEYLESS_HINT,
  mapFreshness,
  normalizeResults,
  requireApiKey,
} from './base.js';

/** Serper.dev — Google results via POST https://google.serper.dev/search (X-API-KEY). 2,500 free credits. */
export class SerperSearch implements SearchProvider {
  readonly id = 'serper';
  private readonly key: string;
  constructor(private readonly opts: BaseSearchOptions = {}) {
    this.key = requireApiKey(
      'Serper',
      opts.apiKey ?? process.env.SERPER_API_KEY,
      ['SERPER_API_KEY'],
      'search.apiKey',
      KEYLESS_HINT,
    );
  }
  capabilities(): SearchCapabilities {
    return {
      requiresApiKey: true,
      keyless: false,
      maxResults: 100,
      supportsFreshness: true,
      supportsDomainFilter: true,
      supportsSafeSearch: false,
      supportsCountry: true,
      supportsLanguage: true,
    };
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    let q = query;
    // Google operators for domain filters
    if (opts.domainsAllow?.length)
      q += ` (${opts.domainsAllow.map((d) => `site:${d}`).join(' OR ')})`;
    if (opts.domainsBlock?.length) q += ` ${opts.domainsBlock.map((d) => `-site:${d}`).join(' ')}`;
    const tbs = mapFreshness(opts.freshness, {
      day: 'qdr:d',
      week: 'qdr:w',
      month: 'qdr:m',
      year: 'qdr:y',
    });
    const json = await requestJson<any>(this.opts.baseUrl ?? 'https://google.serper.dev/search', {
      provider: this.id,
      headers: { 'X-API-KEY': this.key },
      body: {
        q,
        num: Math.min(opts.count ?? 10, 100),
        gl: opts.country?.toLowerCase(),
        hl: opts.language,
        tbs,
        ...(this.opts.options ?? {}),
      },
      timeoutMs: this.opts.timeoutMs,
      signal: opts.signal,
    });
    const items: any[] = json?.organic ?? [];
    const raw: SearchResult[] = items.map((r, i) => ({
      url: r.link,
      title: r.title,
      snippet: r.snippet,
      rank: r.position ?? i + 1,
      publishedAt: r.date,
      source: this.id,
    }));
    return normalizeResults(raw, opts);
  }
}

/** SerpAPI — GET https://serpapi.com/search.json?engine=google. 250 free/month. */
export class SerpApiSearch implements SearchProvider {
  readonly id = 'serpapi';
  private readonly key: string;
  constructor(private readonly opts: BaseSearchOptions = {}) {
    this.key = requireApiKey(
      'SerpAPI',
      opts.apiKey ?? process.env.SERPAPI_API_KEY ?? process.env.SERPAPI_KEY,
      ['SERPAPI_API_KEY'],
      'search.apiKey',
      KEYLESS_HINT,
    );
  }
  capabilities(): SearchCapabilities {
    return {
      requiresApiKey: true,
      keyless: false,
      maxResults: 100,
      supportsFreshness: true,
      supportsDomainFilter: true,
      supportsSafeSearch: true,
      supportsCountry: true,
      supportsLanguage: true,
    };
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    let q = query;
    if (opts.domainsAllow?.length)
      q += ` (${opts.domainsAllow.map((d) => `site:${d}`).join(' OR ')})`;
    if (opts.domainsBlock?.length) q += ` ${opts.domainsBlock.map((d) => `-site:${d}`).join(' ')}`;
    const params = new URLSearchParams({
      engine: 'google',
      q,
      api_key: this.key,
      num: String(Math.min(opts.count ?? 10, 100)),
    });
    if (opts.country) params.set('gl', opts.country.toLowerCase());
    if (opts.language) params.set('hl', opts.language);
    const tbs = mapFreshness(opts.freshness, {
      day: 'qdr:d',
      week: 'qdr:w',
      month: 'qdr:m',
      year: 'qdr:y',
    });
    if (tbs) params.set('tbs', tbs);
    if (opts.safeSearch) params.set('safe', opts.safeSearch === 'off' ? 'off' : 'active');
    const json = await requestJson<any>(
      `${this.opts.baseUrl ?? 'https://serpapi.com/search.json'}?${params}`,
      { provider: this.id, timeoutMs: this.opts.timeoutMs, signal: opts.signal },
    );
    const items: any[] = json?.organic_results ?? [];
    return normalizeResults(
      items.map((r, i) => ({
        url: r.link,
        title: r.title,
        snippet: r.snippet,
        rank: r.position ?? i + 1,
        publishedAt: r.date,
        source: this.id,
      })),
      opts,
    );
  }
}

/**
 * Google Programmable Search (Custom Search JSON API). NOTE: closed to new customers; EOL 2027-01-01.
 * Kept for existing key holders. Requires apiKey + cx.
 */
export class GoogleCseSearch implements SearchProvider {
  readonly id = 'google-cse';
  private readonly key: string;
  private readonly cx: string;
  constructor(private readonly opts: BaseSearchOptions & { cx?: string } = {}) {
    this.key = requireApiKey(
      'Google Custom Search',
      opts.apiKey ?? process.env.GOOGLE_CSE_KEY ?? process.env.GOOGLE_API_KEY,
      ['GOOGLE_CSE_KEY'],
      'search.apiKey',
      'Google CSE is closed to new customers (EOL 2027-01-01) — prefer `search.provider: serper`.',
    );
    this.cx = requireApiKey(
      'Google Custom Search (engine id)',
      opts.cx ?? process.env.GOOGLE_CSE_CX,
      ['GOOGLE_CSE_CX'],
      'search.cx',
    );
  }
  capabilities(): SearchCapabilities {
    return {
      requiresApiKey: true,
      keyless: false,
      maxResults: 10,
      supportsFreshness: true,
      supportsDomainFilter: true,
      supportsSafeSearch: true,
      supportsCountry: true,
      supportsLanguage: true,
    };
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      cx: this.cx,
      q: query,
      num: String(Math.min(opts.count ?? 10, 10)),
    });
    const dr = mapFreshness(opts.freshness, { day: 'd1', week: 'w1', month: 'm1', year: 'y1' });
    if (dr) params.set('dateRestrict', dr);
    if (opts.safeSearch) params.set('safe', opts.safeSearch === 'off' ? 'off' : 'active');
    if (opts.country) params.set('gl', opts.country.toLowerCase());
    if (opts.language) params.set('lr', `lang_${opts.language.split('-')[0]}`);
    if (opts.domainsAllow?.length === 1) params.set('siteSearch', opts.domainsAllow[0] as string);
    const json = await requestJson<any>(
      `${this.opts.baseUrl ?? 'https://customsearch.googleapis.com/customsearch/v1'}?${params}`,
      {
        provider: this.id,
        headers: { 'x-goog-api-key': this.key }, // header, not query string (keeps keys out of logs)
        timeoutMs: this.opts.timeoutMs,
        signal: opts.signal,
      },
    );
    const items: any[] = json?.items ?? [];
    return normalizeResults(
      items.map((r, i) => ({
        url: r.link,
        title: r.title,
        snippet: r.snippet,
        rank: i + 1,
        source: this.id,
      })),
      opts,
    );
  }
}
