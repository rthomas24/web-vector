import { WebVectorError } from '../errors.js';
import type { SearchCapabilities, SearchOptions, SearchProvider, SearchResult } from '../types.js';
import { requestJson } from '../util/http.js';
import {
  type BaseSearchOptions,
  KEYLESS_HINT,
  mapFreshness,
  normalizeResults,
  requireApiKey,
} from './base.js';

/**
 * Tavily — POST https://api.tavily.com/search. Works keyed (Bearer) or keyless
 * (`X-Tavily-Access-Mode: keyless`, rate-limited). Can return raw page content which the pipeline
 * uses to skip fetching when `ingestion.useProviderContent` is on.
 */
export interface TavilyOptions extends BaseSearchOptions {
  keyless?: boolean;
  searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  includeRawContent?: boolean;
  topic?: 'general' | 'news' | 'finance';
}

export class TavilySearch implements SearchProvider {
  readonly id: string;
  private readonly key?: string;
  private readonly keyless: boolean;
  constructor(private readonly opts: TavilyOptions = {}) {
    const key = opts.apiKey ?? process.env.TAVILY_API_KEY;
    this.keyless = opts.keyless ?? !key;
    this.key = this.keyless ? undefined : key;
    this.id = this.keyless ? 'tavily-keyless' : 'tavily';
  }
  capabilities(): SearchCapabilities {
    return {
      requiresApiKey: !this.keyless,
      keyless: this.keyless,
      maxResults: 20,
      supportsFreshness: true,
      supportsDomainFilter: true,
      supportsSafeSearch: false,
      supportsCountry: true,
      supportsLanguage: false,
      returnsContent: this.opts.includeRawContent !== false,
    };
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const headers: Record<string, string> = {};
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    else headers['X-Tavily-Access-Mode'] = 'keyless';
    const body: Record<string, unknown> = {
      query: query.slice(0, 400),
      max_results: Math.min(opts.count ?? 10, 20),
      search_depth: this.opts.searchDepth ?? 'basic',
      topic: this.opts.topic ?? 'general',
      include_raw_content: this.opts.includeRawContent === false ? false : 'markdown',
      include_answer: false,
      include_images: false,
      ...(this.opts.options ?? {}),
    };
    if (opts.domainsAllow?.length) body.include_domains = opts.domainsAllow.slice(0, 300);
    if (opts.domainsBlock?.length) body.exclude_domains = opts.domainsBlock.slice(0, 150);
    if (opts.country) body.country = countryName(opts.country);
    if (typeof opts.freshness === 'string') body.time_range = opts.freshness;
    else if (opts.freshness && typeof opts.freshness === 'object') {
      if (opts.freshness.after) body.start_date = opts.freshness.after;
      if (opts.freshness.before) body.end_date = opts.freshness.before;
    }
    let json: any;
    try {
      json = await requestJson<any>(this.opts.baseUrl ?? 'https://api.tavily.com/search', {
        provider: this.id,
        headers,
        body,
        timeoutMs: this.opts.timeoutMs,
        signal: opts.signal,
        retries: 1,
      });
    } catch (err) {
      if (
        this.keyless &&
        WebVectorError.is(err) &&
        (err.code === 'PROVIDER_RATE_LIMITED' || err.code === 'PROVIDER_AUTH')
      ) {
        throw new WebVectorError('Tavily keyless mode is rate-limited for this client.', {
          code: 'SEARCH_BLOCKED',
          provider: this.id,
          retryable: true,
          remediation:
            'Get a free Tavily key (1,000 credits/month) and set TAVILY_API_KEY, or use another provider.',
          cause: err,
        });
      }
      throw err;
    }
    const items: any[] = json?.results ?? [];
    return normalizeResults(
      items.map((r, i) => ({
        url: r.url,
        title: r.title,
        snippet: r.content,
        rank: i + 1,
        publishedAt: r.published_date,
        source: this.id,
        extra: {
          score: r.score,
          content:
            typeof r.raw_content === 'string' && r.raw_content.length > 200
              ? r.raw_content
              : undefined,
        },
      })),
      opts,
    );
  }
}

/** Exa — POST https://api.exa.ai/search (x-api-key). Neural search; can return page text. */
export interface ExaOptions extends BaseSearchOptions {
  type?: 'auto' | 'instant' | 'fast' | 'deep' | 'keyword' | 'neural';
  includeText?: boolean;
  category?: string;
}

export class ExaSearch implements SearchProvider {
  readonly id = 'exa';
  private readonly key: string;
  constructor(private readonly opts: ExaOptions = {}) {
    this.key = requireApiKey(
      'Exa',
      opts.apiKey ?? process.env.EXA_API_KEY,
      ['EXA_API_KEY'],
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
      supportsLanguage: false,
      returnsContent: this.opts.includeText !== false,
    };
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query,
      type: this.opts.type ?? 'auto',
      numResults: Math.min(opts.count ?? 10, 100),
      ...(this.opts.includeText === false ? {} : { contents: { text: { maxCharacters: 40_000 } } }),
      ...(this.opts.category ? { category: this.opts.category } : {}),
      ...(this.opts.options ?? {}),
    };
    if (opts.domainsAllow?.length) body.includeDomains = opts.domainsAllow;
    if (opts.domainsBlock?.length) body.excludeDomains = opts.domainsBlock;
    if (opts.country) body.userLocation = opts.country.toUpperCase();
    const after = freshnessToDate(opts.freshness);
    if (after) body.startPublishedDate = after;
    if (opts.freshness && typeof opts.freshness === 'object' && opts.freshness.before)
      body.endPublishedDate = opts.freshness.before;
    const json = await requestJson<any>(this.opts.baseUrl ?? 'https://api.exa.ai/search', {
      provider: this.id,
      headers: { 'x-api-key': this.key },
      body,
      timeoutMs: this.opts.timeoutMs,
      signal: opts.signal,
    });
    const items: any[] = json?.results ?? [];
    return normalizeResults(
      items.map((r, i) => ({
        url: r.url,
        title: r.title ?? '',
        snippet:
          Array.isArray(r.highlights) && r.highlights.length
            ? r.highlights.join(' … ')
            : typeof r.text === 'string'
              ? r.text.slice(0, 300)
              : undefined,
        rank: i + 1,
        publishedAt: r.publishedDate,
        source: this.id,
        extra: {
          score: r.score,
          author: r.author,
          content: typeof r.text === 'string' && r.text.length > 200 ? r.text : undefined,
        },
      })),
      opts,
    );
  }
}

/** Perplexity Search API — POST https://api.perplexity.ai/search (Bearer). */
export class PerplexitySearch implements SearchProvider {
  readonly id = 'perplexity';
  private readonly key: string;
  constructor(private readonly opts: BaseSearchOptions = {}) {
    this.key = requireApiKey(
      'Perplexity',
      opts.apiKey ?? process.env.PERPLEXITY_API_KEY,
      ['PERPLEXITY_API_KEY'],
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
      supportsDomainFilter: true,
      supportsSafeSearch: false,
      supportsCountry: true,
      supportsLanguage: true,
    };
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query,
      max_results: Math.min(opts.count ?? 10, 20),
      ...(this.opts.options ?? {}),
    };
    const filters: string[] = [];
    if (opts.domainsAllow?.length) filters.push(...opts.domainsAllow);
    if (opts.domainsBlock?.length) filters.push(...opts.domainsBlock.map((d) => `-${d}`));
    if (filters.length) body.search_domain_filter = filters.slice(0, 20);
    if (typeof opts.freshness === 'string') body.search_recency_filter = opts.freshness;
    if (opts.country) body.country = opts.country.toUpperCase();
    if (opts.language) body.search_language_filter = [opts.language.split('-')[0]];
    const json = await requestJson<any>(this.opts.baseUrl ?? 'https://api.perplexity.ai/search', {
      provider: this.id,
      headers: { authorization: `Bearer ${this.key}` },
      body,
      timeoutMs: this.opts.timeoutMs,
      signal: opts.signal,
    });
    const items: any[] = json?.results ?? [];
    return normalizeResults(
      items.map((r, i) => ({
        url: r.url,
        title: r.title,
        snippet: r.snippet,
        rank: i + 1,
        publishedAt: r.date ?? r.last_updated,
        source: this.id,
      })),
      opts,
    );
  }
}

/** SearXNG — self-hosted metasearch; GET {baseUrl}/search?format=json. Server must enable `search.formats: [html, json]`. */
export class SearxngSearch implements SearchProvider {
  readonly id = 'searxng';
  private readonly base: string;
  constructor(private readonly opts: BaseSearchOptions = {}) {
    const base = opts.baseUrl ?? process.env.SEARXNG_URL ?? process.env.SEARXNG_BASE_URL;
    if (!base) {
      throw new WebVectorError('SearXNG requires a base URL.', {
        code: 'INVALID_CONFIG',
        provider: this.id,
        remediation:
          'Set SEARXNG_URL (e.g. http://localhost:8080) or `search.baseUrl`. Public instances usually block JSON; self-host with `docker run -p 8080:8080 searxng/searxng` and enable `search.formats: [html, json]` in settings.yml.',
      });
    }
    this.base = base.replace(/\/$/, '');
  }
  capabilities(): SearchCapabilities {
    return {
      requiresApiKey: false,
      keyless: true,
      maxResults: 50,
      supportsFreshness: true,
      supportsDomainFilter: false,
      supportsSafeSearch: true,
      supportsCountry: false,
      supportsLanguage: true,
    };
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, format: 'json', categories: 'general' });
    if (opts.language) params.set('language', opts.language);
    if (opts.safeSearch)
      params.set(
        'safesearch',
        opts.safeSearch === 'off' ? '0' : opts.safeSearch === 'strict' ? '2' : '1',
      );
    const tr = mapFreshness(opts.freshness, {
      day: 'day',
      week: 'week',
      month: 'month',
      year: 'year',
    });
    if (tr) params.set('time_range', tr === 'week' ? 'month' : tr); // SearXNG has no `week`
    for (const [k, v] of Object.entries(this.opts.options ?? {})) params.set(k, String(v));
    let json: any;
    try {
      json = await requestJson<any>(`${this.base}/search?${params}`, {
        provider: this.id,
        headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {},
        timeoutMs: this.opts.timeoutMs,
        signal: opts.signal,
      });
    } catch (err) {
      if (WebVectorError.is(err) && err.code === 'PROVIDER_AUTH') {
        throw new WebVectorError(`SearXNG at ${this.base} refused JSON output (403).`, {
          code: 'PROVIDER_AUTH',
          provider: this.id,
          remediation:
            'Enable `search: formats: [html, json]` in the instance settings.yml and disable/allow-list the limiter (limiter.toml pass_ip) for this client.',
          cause: err,
        });
      }
      throw err;
    }
    const items: any[] = json?.results ?? [];
    const results = items
      .filter((r) => r.url)
      .map((r, i) => ({
        url: r.url,
        title: r.title ?? '',
        snippet: r.content,
        rank: i + 1,
        publishedAt: r.publishedDate ?? undefined,
        source: this.id,
        extra: { engines: r.engines, score: r.score },
      }));
    return normalizeResults(results, opts).slice(0, opts.count ?? 10);
  }
}

/** Wikipedia REST search — keyless, stable fallback (entity-style queries). */
export class WikipediaSearch implements SearchProvider {
  readonly id = 'wikipedia';
  private readonly lang: string;
  constructor(
    private readonly opts: BaseSearchOptions & { language?: string; userAgent?: string } = {},
  ) {
    this.lang = opts.language ?? 'en';
  }
  capabilities(): SearchCapabilities {
    return {
      requiresApiKey: false,
      keyless: true,
      maxResults: 50,
      supportsFreshness: false,
      supportsDomainFilter: false,
      supportsSafeSearch: false,
      supportsCountry: false,
      supportsLanguage: true,
    };
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const lang = (opts.language ?? this.lang).split('-')[0] ?? 'en';
    const url = `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${Math.min(opts.count ?? 10, 50)}`;
    const json = await requestJson<any>(url, {
      provider: this.id,
      headers: {
        'user-agent':
          this.opts.userAgent ?? 'WebVector/0.1 (+https://github.com/rthomas24/web-vector)',
      },
      timeoutMs: this.opts.timeoutMs,
      signal: opts.signal,
    });
    const pages: any[] = json?.pages ?? [];
    return normalizeResults(
      pages.map((p, i) => ({
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
        title: p.title,
        snippet: p.excerpt ?? p.description,
        rank: i + 1,
        source: this.id,
      })),
      opts,
    );
  }
}

/** Wrap a plain async function as a SearchProvider. */
export function customSearchProvider(
  id: string,
  fn: (
    query: string,
    opts: SearchOptions,
  ) => Promise<Array<Partial<SearchResult> & { url: string }>>,
  caps: Partial<SearchCapabilities> = {},
): SearchProvider {
  return {
    id,
    capabilities: () => ({
      requiresApiKey: false,
      keyless: true,
      maxResults: 50,
      supportsFreshness: false,
      supportsDomainFilter: false,
      supportsSafeSearch: false,
      supportsCountry: false,
      supportsLanguage: false,
      ...caps,
    }),
    async search(query, opts = {}) {
      const rows = await fn(query, opts);
      return normalizeResults(
        rows.map((r, i) => ({
          title: r.title ?? '',
          rank: r.rank ?? i + 1,
          source: id,
          ...r,
        })) as SearchResult[],
        opts,
      );
    },
  };
}

function freshnessToDate(f: SearchOptions['freshness']): string | undefined {
  if (!f) return undefined;
  if (typeof f === 'object') return f.after;
  const days = { day: 1, week: 7, month: 30, year: 365 }[f];
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const COUNTRY_NAMES: Record<string, string> = {
  us: 'united states',
  gb: 'united kingdom',
  uk: 'united kingdom',
  de: 'germany',
  fr: 'france',
  ca: 'canada',
  au: 'australia',
  in: 'india',
  jp: 'japan',
  es: 'spain',
  it: 'italy',
  nl: 'netherlands',
  br: 'brazil',
  mx: 'mexico',
  se: 'sweden',
  ch: 'switzerland',
};
function countryName(code: string): string {
  return COUNTRY_NAMES[code.toLowerCase()] ?? code;
}
