import { envKeyFor, envUrlFor } from '../config/env.js';
import { WebVectorError } from '../errors.js';
import type {
  Logger,
  SearchCapabilities,
  SearchOptions,
  SearchProvider,
  SearchResult,
} from '../types.js';
import type { BaseSearchOptions } from './base.js';
import { BraveSearch } from './brave.js';
import { DuckDuckGoSearch } from './duckduckgo.js';
import { GoogleCseSearch, SerpApiSearch, SerperSearch } from './google.js';
import {
  ExaSearch,
  PerplexitySearch,
  SearxngSearch,
  TavilySearch,
  WikipediaSearch,
} from './providers.js';

export type { BaseSearchOptions } from './base.js';
export { cleanSnippet, mapFreshness, normalizeResults } from './base.js';
export { BraveSearch } from './brave.js';
export {
  DuckDuckGoSearch,
  decodeDdgHref,
  parseHtml as parseDuckDuckGoHtml,
  parseLite as parseDuckDuckGoLite,
} from './duckduckgo.js';
export { GoogleCseSearch, SerpApiSearch, SerperSearch } from './google.js';
export {
  customSearchProvider,
  ExaSearch,
  PerplexitySearch,
  SearxngSearch,
  TavilySearch,
  WikipediaSearch,
} from './providers.js';

export interface SearchFactoryOptions extends BaseSearchOptions {
  cx?: string;
  [k: string]: unknown;
}

type Factory = (opts: SearchFactoryOptions) => SearchProvider;

const registry = new Map<string, Factory>([
  ['duckduckgo', (o) => new DuckDuckGoSearch(o)],
  ['ddg', (o) => new DuckDuckGoSearch(o)],
  ['brave', (o) => new BraveSearch(o)],
  ['serper', (o) => new SerperSearch(o)],
  ['serpapi', (o) => new SerpApiSearch(o)],
  ['google-cse', (o) => new GoogleCseSearch(o)],
  ['google', (o) => new SerperSearch(o)],
  ['searxng', (o) => new SearxngSearch(o)],
  ['tavily', (o) => new TavilySearch({ ...o, keyless: false })],
  ['tavily-keyless', (o) => new TavilySearch({ ...o, apiKey: undefined, keyless: true })],
  ['exa', (o) => new ExaSearch(o)],
  ['perplexity', (o) => new PerplexitySearch(o)],
  ['wikipedia', (o) => new WikipediaSearch(o)],
]);

/** Register a custom search provider factory usable by name in config files. */
export function registerSearchProvider(name: string, factory: Factory): void {
  registry.set(name, factory);
}

export function listSearchProviders(): string[] {
  return [...registry.keys()];
}

/** Create a provider by name, resolving API keys/URLs from conventional env vars when not passed. */
export function createSearchProvider(
  name: string,
  opts: SearchFactoryOptions = {},
): SearchProvider {
  const factory = registry.get(name);
  if (!factory) {
    throw new WebVectorError(`Unknown search provider "${name}".`, {
      code: 'UNKNOWN_PROVIDER',
      remediation: `Use one of: ${listSearchProviders().join(', ')} — or register a custom one with registerSearchProvider().`,
    });
  }
  return factory({
    ...opts,
    apiKey: opts.apiKey ?? envKeyFor(name),
    baseUrl: opts.baseUrl ?? envUrlFor(name),
  });
}

/**
 * Try providers in order until one succeeds. Non-retryable config errors (MISSING_API_KEY,
 * INVALID_CONFIG) on the *primary* still fall through to keyless fallbacks, but are reported.
 */
export class FallbackSearchProvider implements SearchProvider {
  readonly id: string;
  readonly attempts: { provider: string; ok: boolean; ms: number; error?: string }[] = [];
  constructor(
    private readonly providers: SearchProvider[],
    private readonly logger?: Logger,
  ) {
    if (providers.length === 0)
      throw new WebVectorError('No search providers configured.', { code: 'INVALID_CONFIG' });
    this.id = providers[0]!.id;
  }
  capabilities(): SearchCapabilities {
    return this.providers[0]!.capabilities();
  }
  get primary(): SearchProvider {
    return this.providers[0]!;
  }
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    this.attempts.length = 0;
    const errors: WebVectorError[] = [];
    for (const p of this.providers) {
      const t0 = Date.now();
      try {
        const results = await p.search(query, opts);
        this.attempts.push({ provider: p.id, ok: true, ms: Date.now() - t0 });
        if (results.length === 0 && p !== this.providers.at(-1)) {
          this.logger?.info(`search: ${p.id} returned 0 results, trying next provider`);
          continue;
        }
        return results;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const e = WebVectorError.from(err, {
          code: 'SEARCH_FAILED',
          provider: p.id,
          stage: 'search',
        });
        errors.push(e);
        this.attempts.push({
          provider: p.id,
          ok: false,
          ms: Date.now() - t0,
          error: `${e.code}: ${e.message}`,
        });
        this.logger?.warn(`search: ${p.id} failed (${e.code}): ${e.message}`);
      }
    }
    const first = errors[0];
    throw new WebVectorError(
      `All search providers failed (${errors.map((e) => `${e.provider}: ${e.code}`).join(', ')}).`,
      {
        code: 'SEARCH_FAILED',
        stage: 'search',
        provider: this.id,
        retryable: errors.every((e) => e.retryable),
        remediation:
          first?.remediation ??
          'Check network connectivity and provider configuration (`webvector doctor --live`).',
        details: { errors: errors.map((e) => e.toJSON()) },
        cause: first,
      },
    );
  }
}

/** Build the search stack from config names/instances. */
export function buildSearchStack(input: {
  primary?: string;
  primaryInstance?: SearchProvider;
  fallbacks?: string[];
  fallbackInstances?: SearchProvider[];
  opts?: SearchFactoryOptions;
  logger?: Logger;
}): FallbackSearchProvider {
  const providers: SearchProvider[] = [];
  const skipped: string[] = [];
  const primaryName = input.primary ?? 'duckduckgo';
  if (input.primaryInstance) providers.push(input.primaryInstance);
  else providers.push(createSearchProvider(primaryName, input.opts));
  for (const inst of input.fallbackInstances ?? []) providers.push(inst);
  for (const name of input.fallbacks ?? []) {
    if (name === primaryName) continue;
    try {
      // fallbacks never reuse the primary's apiKey/baseUrl — only env-resolved ones
      providers.push(
        createSearchProvider(name, { timeoutMs: input.opts?.timeoutMs, fetch: input.opts?.fetch }),
      );
    } catch (err) {
      // e.g. keyed fallback without key — skip silently
      skipped.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (skipped.length) input.logger?.debug(`search: skipped fallbacks: ${skipped.join('; ')}`);
  return new FallbackSearchProvider(providers, input.logger);
}
