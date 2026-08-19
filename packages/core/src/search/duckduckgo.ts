import { WebVectorError } from '../errors.js';
import type { SearchCapabilities, SearchOptions, SearchProvider, SearchResult } from '../types.js';
import { withTimeout } from '../util/concurrency.js';
import { type BaseSearchOptions, cleanSnippet, mapFreshness, normalizeResults } from './base.js';

/**
 * Keyless DuckDuckGo search via the no-JS HTML endpoints.
 *
 * Strategy (verified 2026-08-17): POST html.duckduckgo.com/html/ with a browser-like header set →
 * GET html endpoint with a plain UA → POST lite.duckduckgo.com/lite/. A 202/`anomaly.js`/challenge
 * response means bot detection; we rotate to the next strategy and finally throw SEARCH_BLOCKED
 * (retryable) so the pipeline can fall back to another provider.
 */
export interface DuckDuckGoOptions extends BaseSearchOptions {
  /** Region code, e.g. `us-en`, `uk-en`, `wt-wt` (all). Derived from country/language when omitted. */
  region?: string;
  userAgent?: string;
}

const HTML_URL = 'https://html.duckduckgo.com/html/';
const LITE_URL = 'https://lite.duckduckgo.com/lite/';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
const PLAIN_UA = 'Mozilla/5.0';

const FRESHNESS = { day: 'd', week: 'w', month: 'm', year: 'y' } as const;

interface Strategy {
  name: string;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
}

export class DuckDuckGoSearch implements SearchProvider {
  readonly id = 'duckduckgo';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly region?: string;
  private readonly ua?: string;
  private lastGoodStrategy = 0;

  constructor(readonly opts: DuckDuckGoOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.region = opts.region;
    this.ua = opts.userAgent;
  }

  capabilities(): SearchCapabilities {
    return {
      requiresApiKey: false,
      keyless: true,
      maxResults: 30,
      supportsFreshness: true,
      supportsDomainFilter: false,
      supportsSafeSearch: true,
      supportsCountry: true,
      supportsLanguage: true,
    };
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const count = Math.min(opts.count ?? 10, 30);
    const region = this.region ?? regionFor(opts.country, opts.language) ?? 'wt-wt';
    const df = mapFreshness(opts.freshness, FRESHNESS);
    const kp = opts.safeSearch === 'strict' ? '1' : opts.safeSearch === 'off' ? '-2' : '-1';
    const params: Record<string, string> = { q: query.slice(0, 499), kl: region };
    if (df) params.df = df;

    const strategies = this.strategies();
    const errors: string[] = [];
    // start from the strategy that last worked, then wrap around
    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[(this.lastGoodStrategy + i) % strategies.length] as Strategy;
      try {
        const html = await this.request(s, params, kp, opts.signal);
        const results = s.url === LITE_URL ? parseLite(html) : parseHtml(html);
        if (results.length === 0 && looksLikeChallenge(html))
          throw blocked(`${s.name}: challenge page`);
        this.lastGoodStrategy = (this.lastGoodStrategy + i) % strategies.length;
        return normalizeResults(results.slice(0, count), opts).map((r) => ({
          ...r,
          source: this.id,
        }));
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${s.name}: ${msg}`);
        if (
          WebVectorError.is(err) &&
          err.code !== 'SEARCH_BLOCKED' &&
          err.code !== 'PROVIDER_ERROR'
        )
          throw err;
      }
    }
    throw new WebVectorError(
      `DuckDuckGo blocked or failed all request strategies (${errors.join(' | ')}).`,
      {
        code: 'SEARCH_BLOCKED',
        provider: this.id,
        retryable: true,
        remediation:
          'DuckDuckGo is rate-limiting this IP or changed its markup. Retry later, lower request rate, or configure a keyed provider (brave, serper, tavily) or a self-hosted SearXNG. WebVector will try `search.fallbackProviders` automatically.',
        details: { errors },
      },
    );
  }

  private strategies(): Strategy[] {
    const ua = this.ua ?? BROWSER_UA;
    return [
      {
        name: 'html-post',
        url: HTML_URL,
        method: 'POST',
        headers: {
          'user-agent': ua,
          accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          referer: 'https://html.duckduckgo.com/',
          origin: 'https://html.duckduckgo.com',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-user': '?1',
          'upgrade-insecure-requests': '1',
          'content-type': 'application/x-www-form-urlencoded',
        },
      },
      {
        name: 'html-get',
        url: HTML_URL,
        method: 'GET',
        headers: {
          'user-agent': this.ua ?? PLAIN_UA,
          accept: 'text/html',
          'accept-language': 'en-US,en;q=0.9',
        },
      },
      {
        name: 'lite-post',
        url: LITE_URL,
        method: 'POST',
        headers: {
          'user-agent': this.ua ?? PLAIN_UA,
          accept: 'text/html',
          'accept-language': 'en-US,en;q=0.9',
          'content-type': 'application/x-www-form-urlencoded',
          referer: 'https://lite.duckduckgo.com/',
        },
      },
    ];
  }

  private async request(
    s: Strategy,
    params: Record<string, string>,
    kp: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const body = new URLSearchParams({ ...params, b: '' }).toString();
    const url = s.method === 'GET' ? `${s.url}?${new URLSearchParams(params).toString()}` : s.url;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: s.method,
        headers: {
          ...s.headers,
          cookie: `kl=${params.kl}; p=${kp}${params.df ? `; df=${params.df}` : ''}`,
        },
        body: s.method === 'POST' ? body : undefined,
        redirect: 'follow',
        signal: withTimeout(this.timeoutMs, signal),
      });
    } catch (err) {
      throw WebVectorError.from(err, {
        code: 'PROVIDER_ERROR',
        provider: this.id,
        retryable: true,
      });
    }
    const html = await res.text();
    if (res.status === 202 || res.status === 403 || res.status === 429)
      throw blocked(`HTTP ${res.status}`);
    if (!res.ok) {
      throw new WebVectorError(`DuckDuckGo returned HTTP ${res.status}`, {
        code: 'PROVIDER_ERROR',
        provider: this.id,
        retryable: res.status >= 500,
      });
    }
    if (looksLikeChallenge(html)) throw blocked('challenge page');
    return html;
  }
}

function blocked(reason: string): WebVectorError {
  return new WebVectorError(`DuckDuckGo bot detection (${reason})`, {
    code: 'SEARCH_BLOCKED',
    provider: 'duckduckgo',
    retryable: true,
  });
}

export function looksLikeChallenge(html: string): boolean {
  return /anomaly\.js|challenge-form|bots use DuckDuckGo too|anomalyDetectionBlock|Select all squares/i.test(
    html,
  );
}

function regionFor(country?: string, language?: string): string | undefined {
  if (!country && !language) return undefined;
  const c = (country ?? 'wt').toLowerCase();
  const l = (language ?? 'en').toLowerCase().split('-')[0];
  return `${c}-${l}`;
}

/** Decode DDG redirect links (`//duckduckgo.com/l/?uddg=<url>&rut=…`) to the target URL. */
export function decodeDdgHref(href: string): string | null {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.hostname.endsWith('duckduckgo.com')) {
      const target = u.searchParams.get('uddg');
      if (target) return target;
      // ads / internal
      if (u.pathname.startsWith('/y.js') || u.pathname.startsWith('/l/')) return null;
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** Parse html.duckduckgo.com results (regex-based; markup verified 2026-08). */
export function parseHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRe =
    /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresult\b[^"]*"|<div class="nav-link"|<\/div>\s*<\/div>\s*<\/div>\s*<div id="bottom_links"|$)/g;
  const blocks = html.match(blockRe) ?? [];
  let rank = 0;
  for (const block of blocks) {
    if (/result--ad|y\.js/.test(block)) continue;
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const url = decodeDdgHref(a[1] as string);
    if (!url) continue;
    const title = cleanSnippet(a[2]) ?? '';
    const sn =
      /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ??
      /<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const snippet = cleanSnippet(sn?.[1]);
    rank++;
    results.push({ url, title, snippet, rank, source: 'duckduckgo' });
  }
  return results;
}

/** Parse lite.duckduckgo.com results (table layout: a.result-link + td.result-snippet). */
export function parseLite(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+href="([^"]+)"[^>]+class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const linkRe2 = /<a[^>]+class=['"]result-link['"][^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  const links: { url: string; title: string }[] = [];
  for (const re of [linkRe, linkRe2]) {
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex loop
    while ((m = re.exec(html))) {
      const url = decodeDdgHref(m[1] as string);
      if (!url) continue;
      if (links.some((l) => l.url === url)) continue;
      links.push({ url, title: cleanSnippet(m[2]) ?? '' });
    }
  }
  const snippets: string[] = [];
  let s: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex loop
  while ((s = snippetRe.exec(html))) snippets.push(cleanSnippet(s[1]) ?? '');
  links.forEach((l, i) =>
    results.push({
      url: l.url,
      title: l.title,
      snippet: snippets[i],
      rank: i + 1,
      source: 'duckduckgo',
    }),
  );
  return results;
}
