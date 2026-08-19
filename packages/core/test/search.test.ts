import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebVectorError } from '../src/errors.js';
import { cleanSnippet } from '../src/search/base.js';
import {
  decodeDdgHref,
  looksLikeChallenge,
  parseHtml,
  parseLite,
} from '../src/search/duckduckgo.js';
import {
  BraveSearch,
  createSearchProvider,
  customSearchProvider,
  DuckDuckGoSearch,
  ExaSearch,
  FallbackSearchProvider,
  normalizeResults,
  SearxngSearch,
  SerperSearch,
  TavilySearch,
  WikipediaSearch,
} from '../src/search/index.js';

const fx = (n: string) => readFileSync(join(import.meta.dirname, 'fixtures', n), 'utf8');
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('duckduckgo parsers', () => {
  it('parses html endpoint results with uddg redirects', () => {
    const r = parseHtml(fx('ddg-html.html'));
    expect(r.length).toBeGreaterThanOrEqual(8);
    expect(r[0]!.url).toMatch(/^https:\/\/learn\.microsoft\.com/);
    expect(r[0]!.title).toContain('RRF');
    expect(r[0]!.snippet).toContain('Reciprocal Rank Fusion');
    expect(r.every((x) => !x.url.includes('duckduckgo.com'))).toBe(true);
  });
  it('parses lite endpoint results', () => {
    const r = parseLite(fx('ddg-lite.html'));
    expect(r.length).toBeGreaterThanOrEqual(8);
    expect(r[0]!.url).toMatch(/^https:\/\//);
    expect(r[0]!.snippet).toBeTruthy();
  });
  it('detects challenge pages', () => {
    expect(looksLikeChallenge(fx('ddg-challenge.html'))).toBe(true);
    expect(looksLikeChallenge(fx('ddg-html.html'))).toBe(false);
    expect(parseHtml(fx('ddg-challenge.html'))).toHaveLength(0);
  });
  it('decodes hrefs', () => {
    expect(decodeDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x')).toBe(
      'https://example.com/a',
    );
    expect(decodeDdgHref('https://example.com/b')).toBe('https://example.com/b');
    expect(decodeDdgHref('//duckduckgo.com/y.js?ad')).toBeNull();
  });
});

describe('DuckDuckGoSearch strategies', () => {
  it('falls back from a 202 challenge to the next strategy', async () => {
    let calls = 0;
    server.use(
      http.post('https://html.duckduckgo.com/html/', () => {
        calls++;
        return new HttpResponse(fx('ddg-challenge.html'), { status: 202 });
      }),
      http.get('https://html.duckduckgo.com/html/', () => {
        calls++;
        return HttpResponse.html(fx('ddg-html.html'));
      }),
    );
    const p = new DuckDuckGoSearch();
    const r = await p.search('reciprocal rank fusion', { count: 5 });
    expect(r).toHaveLength(5);
    expect(calls).toBe(2);
    // second call starts from the strategy that worked
    await p.search('again');
    expect(calls).toBe(3);
  });
  it('throws SEARCH_BLOCKED when everything is blocked', async () => {
    server.use(
      http.post('https://html.duckduckgo.com/html/', () => new HttpResponse('', { status: 202 })),
      http.get('https://html.duckduckgo.com/html/', () => new HttpResponse('', { status: 403 })),
      http.post('https://lite.duckduckgo.com/lite/', () => new HttpResponse('', { status: 429 })),
    );
    await expect(new DuckDuckGoSearch().search('x')).rejects.toMatchObject({
      code: 'SEARCH_BLOCKED',
      retryable: true,
    });
  });
});

describe('keyed providers', () => {
  it('brave maps params and response', async () => {
    let seenUrl = '';
    let seenKey = '';
    server.use(
      http.get('https://api.search.brave.com/res/v1/web/search', ({ request }) => {
        seenUrl = request.url;
        seenKey = request.headers.get('x-subscription-token') ?? '';
        return HttpResponse.json({
          web: {
            results: [
              {
                url: 'https://a.com/x',
                title: 'A',
                description: 'd <strong>x</strong>',
                page_age: '2026-01-01T00:00:00',
                extra_snippets: ['e1'],
              },
              { url: 'https://a.com/x#frag', title: 'dup', description: 'd' },
            ],
          },
        });
      }),
    );
    const r = await new BraveSearch({ apiKey: 'BSAtest' }).search('q', {
      count: 5,
      freshness: 'week',
      country: 'us',
    });
    expect(seenKey).toBe('BSAtest');
    expect(seenUrl).toContain('freshness=pw');
    expect(seenUrl).toContain('country=US');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      url: 'https://a.com/x',
      title: 'A',
      snippet: 'd x',
      publishedAt: '2026-01-01T00:00:00',
      source: 'brave',
    });
    expect(r[0]!.extra?.extraSnippets).toEqual(['e1']);
  });
  it('brave requires a key', () => {
    expect(() => new BraveSearch({ apiKey: undefined })).toThrow(WebVectorError);
    try {
      new BraveSearch({});
    } catch (e) {
      expect((e as WebVectorError).code).toBe('MISSING_API_KEY');
      expect((e as WebVectorError).remediation).toContain('BRAVE_API_KEY');
    }
  });
  it('serper posts JSON and applies domain operators', async () => {
    let body: any;
    server.use(
      http.post('https://google.serper.dev/search', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          organic: [
            { link: 'https://b.com/1', title: 'B', snippet: 's', position: 1, date: 'Jan 1, 2026' },
          ],
        });
      }),
    );
    const r = await new SerperSearch({ apiKey: 'k' }).search('q', {
      domainsAllow: ['b.com'],
      freshness: 'day',
    });
    expect(body.q).toContain('site:b.com');
    expect(body.tbs).toBe('qdr:d');
    expect(r[0]).toMatchObject({ url: 'https://b.com/1', source: 'serper' });
  });
  it('tavily keyless mode sets header and surfaces raw content', async () => {
    let headers: Headers | undefined;
    server.use(
      http.post('https://api.tavily.com/search', ({ request }) => {
        headers = request.headers;
        return HttpResponse.json({
          results: [
            {
              url: 'https://t.com/a',
              title: 'T',
              content: 'snip',
              score: 0.9,
              raw_content: 'x'.repeat(500),
            },
          ],
        });
      }),
    );
    const p = new TavilySearch({ apiKey: undefined });
    expect(p.id).toBe('tavily-keyless');
    const r = await p.search('q');
    expect(headers?.get('x-tavily-access-mode')).toBe('keyless');
    expect(r[0]!.extra?.content).toHaveLength(500);
  });
  it('tavily keyless 429 → SEARCH_BLOCKED', async () => {
    server.use(
      http.post('https://api.tavily.com/search', () => new HttpResponse('limit', { status: 429 })),
    );
    await expect(new TavilySearch({ keyless: true }).search('q')).rejects.toMatchObject({
      code: 'SEARCH_BLOCKED',
    });
  });
  it('exa maps results with text', async () => {
    server.use(
      http.post('https://api.exa.ai/search', () =>
        HttpResponse.json({
          results: [
            {
              url: 'https://e.com',
              title: 'E',
              text: 'y'.repeat(300),
              publishedDate: '2026-02-02',
            },
          ],
        }),
      ),
    );
    const r = await new ExaSearch({ apiKey: 'k' }).search('q');
    expect(r[0]!.extra?.content).toHaveLength(300);
    expect(r[0]!.publishedAt).toBe('2026-02-02');
  });
  it('searxng needs a url and maps json', async () => {
    expect(() => new SearxngSearch({ baseUrl: undefined })).toThrow();
    server.use(
      http.get('http://sx.local/search', () =>
        HttpResponse.json({
          results: [{ url: 'https://s.com', title: 'S', content: 'c', engines: ['ddg'] }],
        }),
      ),
    );
    const r = await new SearxngSearch({ baseUrl: 'http://sx.local' }).search('q');
    expect(r[0]).toMatchObject({ url: 'https://s.com/', source: 'searxng' });
  });
  it('wikipedia builds urls from keys', async () => {
    server.use(
      http.get('https://en.wikipedia.org/w/rest.php/v1/search/page', () =>
        HttpResponse.json({
          pages: [
            {
              key: 'Learning_to_rank',
              title: 'Learning to rank',
              excerpt: '<span class="searchmatch">rank</span> stuff',
            },
          ],
        }),
      ),
    );
    const r = await new WikipediaSearch().search('rank');
    expect(r[0]!.url).toBe('https://en.wikipedia.org/wiki/Learning_to_rank');
    expect(r[0]!.snippet).toBe('rank stuff');
  });
  it('rate limit surfaces retry-after', async () => {
    let n = 0;
    server.use(
      http.get('https://api.search.brave.com/res/v1/web/search', () => {
        n++;
        return new HttpResponse('slow down', { status: 429, headers: { 'retry-after': '0' } });
      }),
    );
    await expect(new BraveSearch({ apiKey: 'k' }).search('q')).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      retryable: true,
    });
    expect(n).toBe(3); // 1 + 2 retries
  });
});

describe('normalisation + fallback', () => {
  it('normalizeResults dedupes and filters', () => {
    const r = normalizeResults(
      [
        { url: 'https://www.a.com/x?utm_source=1', title: 'A', rank: 2, source: 't' },
        { url: 'https://a.com/x', title: 'A2', rank: 1, source: 't' },
        { url: 'https://img.com/p.png', title: 'img', rank: 3, source: 't' },
        { url: 'https://blocked.com/z', title: 'blk', rank: 4, source: 't' },
        { url: 'javascript:alert(1)', title: 'js', rank: 5, source: 't' },
      ],
      { domainsBlock: ['blocked.com'] },
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toBe('A2');
  });
  it('FallbackSearchProvider tries providers in order and records attempts', async () => {
    const bad = customSearchProvider('bad', async () => {
      throw new WebVectorError('down', { code: 'PROVIDER_ERROR', retryable: true });
    });
    const empty = customSearchProvider('empty', async () => []);
    const good = customSearchProvider('good', async () => [{ url: 'https://g.com/1', title: 'G' }]);
    const fb = new FallbackSearchProvider([bad, empty, good]);
    const r = await fb.search('q');
    expect(r[0]!.source).toBe('good');
    expect(fb.attempts.map((a) => `${a.provider}:${a.ok}`)).toEqual([
      'bad:false',
      'empty:true',
      'good:true',
    ]);
  });
  it('FallbackSearchProvider throws SEARCH_FAILED when all fail', async () => {
    const bad = customSearchProvider('bad', async () => {
      throw new Error('x');
    });
    await expect(new FallbackSearchProvider([bad]).search('q')).rejects.toMatchObject({
      code: 'SEARCH_FAILED',
    });
  });
  it('createSearchProvider unknown name', () => {
    expect(() => createSearchProvider('nope')).toThrow(/Unknown search provider/);
  });
});

describe('snippet hardening', () => {
  it('cleanSnippet never throws on out-of-range/control entities and strips them', () => {
    expect(cleanSnippet('a &#1114112; b &#0; c &#27;[31m d &amp;#9999999; e')).toBe(
      'a b c [31m d &#9999999; e',
    );
    expect(cleanSnippet('&lt;b&gt;x&lt;/b&gt; &amp;amp; &#x1F600;')).toBe('<b>x</b> &amp; 😀');
    expect(cleanSnippet('x'.repeat(5000))!.length).toBeLessThanOrEqual(2000);
  });
  it('a hostile snippet in one result does not break the whole provider batch', async () => {
    server.use(
      http.post('https://google.serper.dev/search', () =>
        HttpResponse.json({
          organic: [
            {
              link: 'https://ok.com/1',
              title: 'A &#99999999999;',
              snippet: '&#1114112;',
              position: 1,
            },
          ],
        }),
      ),
    );
    const r = await new SerperSearch({ apiKey: 'k' }).search('q');
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toBe('A');
  });
});
