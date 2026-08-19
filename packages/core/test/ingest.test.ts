import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { approxTokens, chunkMarkdown } from '../src/ingest/chunker.js';
import { Fetcher, parseContentType } from '../src/ingest/fetcher.js';
import {
  createParsers,
  HtmlParser,
  markdownToText,
  PdfParser,
  selectParser,
  TextParser,
} from '../src/ingest/parsers.js';
import { RobotsCache } from '../src/ingest/robots.js';
import { assertSafeUrl, isPublicIp } from '../src/ingest/ssrf.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const publicResolve = async () => ['93.184.216.34'];

function fetcher(over: Partial<ConstructorParameters<typeof Fetcher>[0]> = {}) {
  return new Fetcher({
    userAgent: 'WebVector-test',
    timeoutMs: 2000,
    maxRedirects: 3,
    maxBytes: 10_000,
    maxConcurrentFetches: 4,
    perHostConcurrency: 2,
    perHostMinIntervalMs: 0,
    respectRobotsTxt: false,
    retries: 0,
    allowPrivateNetworks: false,
    resolve: publicResolve,
    ...over,
  });
}

describe('ssrf', () => {
  it('classifies ips', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('127.0.0.1')).toBe(false);
    expect(isPublicIp('10.1.2.3')).toBe(false);
    expect(isPublicIp('169.254.169.254')).toBe(false);
    expect(isPublicIp('100.64.0.1')).toBe(false);
    expect(isPublicIp('::1')).toBe(false);
    expect(isPublicIp('::ffff:7f00:1')).toBe(false);
    expect(isPublicIp('2606:4700::1111')).toBe(true);
    expect(isPublicIp('fd00::1')).toBe(false);
  });
  it('blocks bad schemes, hosts, ip literals, and dns to private', async () => {
    await expect(assertSafeUrl(new URL('ftp://x.com/'))).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_SSRF',
    });
    await expect(assertSafeUrl(new URL('http://localhost/'))).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_SSRF',
    });
    await expect(assertSafeUrl(new URL('http://foo.internal/'))).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_SSRF',
    });
    await expect(assertSafeUrl(new URL('http://127.0.0.1:8080/'))).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_SSRF',
    });
    await expect(assertSafeUrl(new URL('http://[::ffff:127.0.0.1]/'))).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_SSRF',
    });
    await expect(
      assertSafeUrl(new URL('http://evil.example/'), {
        resolve: async () => ['1.2.3.4', '10.0.0.1'],
      }),
    ).rejects.toMatchObject({ code: 'FETCH_BLOCKED_SSRF' });
    await expect(
      assertSafeUrl(new URL('http://ok.example/'), { resolve: async () => ['1.2.3.4'] }),
    ).resolves.toEqual(['1.2.3.4']);
    await expect(
      assertSafeUrl(new URL('http://localhost/'), { allowPrivateNetworks: true }),
    ).resolves.toEqual([]);
  });
});

describe('fetcher', () => {
  it('follows redirects manually with cap and per-hop ssrf', async () => {
    server.use(
      http.get(
        'https://a.example/1',
        () => new HttpResponse(null, { status: 302, headers: { location: '/2' } }),
      ),
      http.get(
        'https://a.example/2',
        () => new HttpResponse(null, { status: 301, headers: { location: 'https://a.example/3' } }),
      ),
      http.get('https://a.example/3', () =>
        HttpResponse.text('done', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
      ),
    );
    const r = await fetcher().fetch('https://a.example/1');
    expect(r.finalUrl).toBe('https://a.example/3');
    expect(r.redirects).toBe(2);
    expect(r.contentType).toBe('text/plain');
    expect(r.charset).toBe('utf-8');
    expect(new TextDecoder().decode(r.bytes)).toBe('done');
  });
  it('rejects too many redirects', async () => {
    server.use(
      http.get(
        'https://loop.example/*',
        () => new HttpResponse(null, { status: 302, headers: { location: '/x' } }),
      ),
    );
    await expect(fetcher().fetch('https://loop.example/x')).rejects.toMatchObject({
      code: 'TOO_MANY_REDIRECTS',
    });
  });
  it('blocks redirect to private target', async () => {
    server.use(
      http.get(
        'https://a.example/r',
        () =>
          new HttpResponse(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
      ),
    );
    await expect(fetcher().fetch('https://a.example/r')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_SSRF',
    });
  });
  it('enforces size cap via content-length and streaming', async () => {
    server.use(
      http.get(
        'https://big.example/cl',
        () => new HttpResponse('x', { headers: { 'content-length': '999999' } }),
      ),
      http.get('https://big.example/stream', () => new HttpResponse('y'.repeat(20_000))),
    );
    await expect(fetcher().fetch('https://big.example/cl')).rejects.toMatchObject({
      code: 'FETCH_TOO_LARGE',
    });
    await expect(fetcher().fetch('https://big.example/stream')).rejects.toMatchObject({
      code: 'FETCH_TOO_LARGE',
    });
  });
  it('maps http errors and retries 503', async () => {
    let n = 0;
    server.use(
      http.get('https://err.example/404', () => new HttpResponse('nf', { status: 404 })),
      http.get('https://err.example/503', () => {
        n++;
        return n < 2 ? new HttpResponse('busy', { status: 503 }) : HttpResponse.text('ok');
      }),
    );
    await expect(fetcher().fetch('https://err.example/404')).rejects.toMatchObject({
      code: 'FETCH_HTTP_ERROR',
      retryable: false,
    });
    const r = await fetcher({ retries: 2 }).fetch('https://err.example/503');
    expect(new TextDecoder().decode(r.bytes)).toBe('ok');
    expect(n).toBe(2);
  });
  it('honours robots.txt disallow and crawl-delay', async () => {
    server.use(
      http.get('https://r.example/robots.txt', () =>
        HttpResponse.text('User-agent: *\nDisallow: /private\nCrawl-delay: 1\n', {
          headers: { 'content-type': 'text/plain' },
        }),
      ),
      http.get('https://r.example/public', () => HttpResponse.text('pub')),
    );
    const f = fetcher({ respectRobotsTxt: true });
    await expect(f.fetch('https://r.example/private/x')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_ROBOTS',
    });
    const r = await f.fetch('https://r.example/public');
    expect(new TextDecoder().decode(r.bytes)).toBe('pub');
  });
  it('robots: 5xx/404 allow all', async () => {
    server.use(
      http.get('https://r2.example/robots.txt', () => new HttpResponse('', { status: 500 })),
    );
    const rc = new RobotsCache({ userAgent: 'WebVector' });
    expect((await rc.check('https://r2.example/x')).allowed).toBe(true);
  });
  it('parseContentType', () => {
    expect(parseContentType('text/HTML; charset=ISO-8859-1')).toEqual({
      type: 'text/html',
      charset: 'iso-8859-1',
    });
    expect(parseContentType('')).toEqual({ type: '', charset: undefined });
  });
});

describe('parsers', () => {
  const html = `<!doctype html><html lang="en"><head><title>Test Page | Site</title>
  <meta property="og:site_name" content="Site"><meta property="article:published_time" content="2026-05-01T00:00:00Z">
  <template shadowrootmode="open"><style>.leak{color:red}</style><p>TEMPLATE LEAK</p></template>
  <script>var x = 1;</script></head><body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <article><h1>Reciprocal Rank Fusion</h1>
  <p>Reciprocal rank fusion (RRF) is a method for combining multiple result sets with different relevance indicators into a single result set. It requires no tuning and works well across heterogeneous systems. ${'More explanatory text about fusion. '.repeat(20)}</p>
  <h2>Formula</h2><p>The score is <code>1/(k+rank)</code> summed over lists. See <a href="/paper">the paper</a>.</p>
  <pre><code>score = sum(1/(k+r))</code></pre></article>
  <footer>© Site</footer></body></html>`;

  it('HtmlParser extracts main content as markdown with metadata; strips template leak; resolves links', async () => {
    const doc = await new HtmlParser().parseHtml(html, 'https://site.example/post');
    expect(doc).not.toBeNull();
    expect(doc!.title).toContain('Test Page');
    expect(doc!.markdown).toContain('1/(k+rank)');
    expect(doc!.markdown).not.toContain('TEMPLATE LEAK');
    expect(doc!.markdown).not.toContain('.leak');
    expect(doc!.markdown).toContain('https://site.example/paper');
    expect(doc!.siteName).toBe('Site');
    expect(doc!.publishedAt).toBe('2026-05-01T00:00:00Z');
    expect(doc!.lang).toBe('en');
    expect(doc!.text).not.toContain('](');
  });
  it('HtmlParser returns null on empty pages', async () => {
    expect(
      await new HtmlParser().parseHtml('<html><body><p>hi</p></body></html>', 'https://x.example/'),
    ).toBeNull();
  });
  it('TextParser handles markdown with frontmatter and json', async () => {
    const md = await new TextParser().parse(
      new TextEncoder().encode(
        '---\ntitle: My Doc\n---\n# Heading\n\nBody text that is long enough to count as content for sure.',
      ),
      { url: 'https://x/a.md', contentType: 'text/markdown' },
    );
    expect(md!.title).toBe('My Doc');
    expect(md!.markdown.startsWith('# Heading')).toBe(true);
    const json = await new TextParser().parse(
      new TextEncoder().encode(JSON.stringify({ a: 1, b: 'two two two two two two two two' })),
      { url: 'https://x/a.json', contentType: 'application/json' },
    );
    expect(json!.markdown).toContain('```json');
  });
  it('selectParser sniffs pdf/html', () => {
    const parsers = createParsers();
    expect(
      selectParser(parsers, '', 'https://x/doc', new TextEncoder().encode('%PDF-1.7 ...'))?.id,
    ).toBe('pdf');
    expect(
      selectParser(parsers, '', 'https://x/doc', new TextEncoder().encode('<!doctype html><html>'))
        ?.id,
    ).toBe('html');
    expect(selectParser(parsers, 'image/png', 'https://x/p', new Uint8Array())).toBeUndefined();
    expect(new PdfParser().canHandle('application/pdf', 'https://x/y')).toBe(true);
  });
  it('markdownToText strips syntax', () => {
    expect(markdownToText('# H\n\n**bold** [link](http://x) `code`\n- item')).toBe(
      'H\n\nbold link code\nitem',
    );
  });
});

describe('chunker', () => {
  it('splits by headings with breadcrumbs, offsets, and atomic code fences', () => {
    const md = `# Title\n\nIntro paragraph. ${'word '.repeat(300)}\n\n## Section A\n\nA text. ${'alpha '.repeat(200)}\n\nLead-in:\n\n\`\`\`js\nconst x = 1;\nconst y = 2;\n\`\`\`\n\n### Sub A1\n\nSub text ${'beta '.repeat(50)}\n\n## Section B\n\nB text ${'gamma '.repeat(100)}`;
    const chunks = chunkMarkdown(md, { chunkSize: 120, chunkOverlap: 10, title: 'Doc' });
    expect(chunks.length).toBeGreaterThan(4);
    for (const c of chunks) {
      expect(md.slice(c.startOffset, c.endOffset)).toBe(c.text);
      expect(approxTokens(c.text)).toBeLessThanOrEqual(120 * 1.6);
      expect(c.index).toBe(chunks.indexOf(c));
    }
    const code = chunks.find((c) => c.text.includes('const x = 1'));
    expect(code).toBeDefined();
    expect(code!.text).toContain('```js');
    expect(code!.text).toContain('Lead-in:'); // merged with preceding lead-in
    const sub = chunks.find((c) => c.text.includes('Sub text'));
    expect(sub!.breadcrumb).toBe('Doc › Title › Section A › Sub A1');
    expect(sub!.embedText.startsWith('Doc › Title › Section A')).toBe(true);
  });
  it('respects maxChunks and minChunkChars', () => {
    const md = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} ${'x '.repeat(100)}`).join(
      '\n\n',
    );
    expect(chunkMarkdown(md, { chunkSize: 60, maxChunks: 5 })).toHaveLength(5);
    expect(chunkMarkdown('tiny', {})).toHaveLength(0);
  });
  it('hard-splits pathological text without separators', () => {
    const chunks = chunkMarkdown('a'.repeat(5000), { chunkSize: 100, minChunkChars: 10 });
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.text.length <= 100 * 4 + 33 * 4 + 8)).toBe(true); // chunk + overlap
  });
});

describe('robots.txt hardening', () => {
  it('does not follow robots.txt redirects (treats 3xx as allow-all)', async () => {
    let followed = false;
    server.use(
      http.get(
        'https://rr.example/robots.txt',
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1:1/robots.txt' },
          }),
      ),
      http.get('http://127.0.0.1:1/robots.txt', () => {
        followed = true;
        return HttpResponse.text('User-agent: *\nDisallow: /');
      }),
    );
    const rc = new RobotsCache({ userAgent: 'WebVector' });
    expect((await rc.check('https://rr.example/x')).allowed).toBe(true);
    expect(followed).toBe(false);
  });
});
