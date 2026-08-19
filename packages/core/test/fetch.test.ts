/**
 * Fetch-robustness stream: markdown-first negotiation, bot-block classification, early aborts,
 * Content-Signal etiquette, URL hygiene, fast paths, provider-content gate, archive fallback.
 */
import { readFileSync } from 'node:fs';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cooldownFastPath,
  registerFastPath,
  selectFastPath,
  stackExchangeSite,
} from '../src/ingest/fast-paths.js';
import { acceptHeaderFor, Fetcher, parseContentSignal } from '../src/ingest/fetcher.js';
import {
  assessProviderContent,
  ingestUrl,
  parseResource,
  resetArchiveFallbackState,
} from '../src/ingest/index.js';
import {
  cleanServedMarkdown,
  isServedMarkdown,
  parseServedMarkdown,
} from '../src/ingest/markdown-clean.js';
import { contentSignalFor, parseContentSignalGroups } from '../src/ingest/robots.js';
import { WebVector } from '../src/pipeline/webvector.js';
import { customSearchProvider } from '../src/search/providers.js';
import { silentLogger } from '../src/util/logger.js';
import { canonicalizeUrl, cleanUrl, normalizeUrl } from '../src/util/url.js';

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
    maxBytes: 100_000,
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

const enc = (s: string) => new TextEncoder().encode(s);

// ─── C1 markdown-first content negotiation ───────────────────────────────────

describe('markdown-first content negotiation', () => {
  it('sends the Accept header for each acceptMarkdown mode', async () => {
    const seen: string[] = [];
    server.use(
      http.get('https://md.example/page', ({ request }) => {
        seen.push(request.headers.get('accept') ?? '');
        return HttpResponse.text('# Hi\n\nBody text long enough to be a document for the parser.', {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        });
      }),
    );
    await fetcher().fetch('https://md.example/page');
    await fetcher({ acceptMarkdown: 'accept' }).fetch('https://md.example/page');
    await fetcher({ acceptMarkdown: 'off' }).fetch('https://md.example/page');
    expect(seen[0]).toBe(acceptHeaderFor('prefer'));
    expect(seen[0]?.startsWith('text/markdown, text/html;q=0.9')).toBe(true);
    expect(seen[1]?.startsWith('text/html')).toBe(true);
    expect(seen[1]).toContain('text/markdown;q=0.8');
    expect(seen[2]).not.toContain('markdown');
  });

  it('cleans Cloudflare-style served markdown (frontmatter, skip link, doc index)', () => {
    const raw = [
      '---',
      'description: Converts HTML to Markdown at the edge.',
      'title: Markdown for Agents',
      'date: 2026-07-13',
      'image: https://developers.cloudflare.com/og-docs.png',
      '---',
      '',
      '[Skip to content](#main-content)',
      '',
      '> Documentation Index  ',
      '> Fetch the complete documentation index at: https://developers.cloudflare.com/fundamentals/llms.txt  ',
      '> Use this file to discover all available pages before exploring further.',
      '',
      '# Markdown for Agents',
      '',
      'Markdown has quickly become the lingua franca for agents.',
    ].join('\n');
    const c = cleanServedMarkdown(raw);
    expect(c.title).toBe('Markdown for Agents');
    expect(c.description).toContain('Converts HTML');
    expect(c.publishedAt).toBe('2026-07-13T00:00:00.000Z');
    expect(c.frontmatter.image).toContain('og-docs.png');
    expect(c.markdown.startsWith('# Markdown for Agents')).toBe(true);
    expect(c.markdown).not.toContain('Skip to content');
    expect(c.markdown).not.toContain('Documentation Index');
    expect(c.markdown).toContain('lingua franca');
  });

  it('cleans Mintlify-style MDX (import/export, JSX tags, fence attributes) and keeps code', () => {
    const raw = [
      "import { Card } from '/snippets/card.mdx';",
      '',
      '# Markdown export',
      '',
      '> Export clean Markdown versions of your documentation pages.',
      '',
      'export const PreviewButton = ({children, href}) => {',
      '  return <a href={href} className="text-sm">',
      '        {children}',
      '      </a>;',
      '};',
      '',
      'Markdown provides structured text that AI tools can process.',
      '',
      '<PreviewButton href="https://mintlify.com/docs/x.md">Open this page as Markdown</PreviewButton>',
      '',
      '<Card',
      '  title="Multi-line"',
      '  icon="rocket"',
      '>',
      'Inside the card.',
      '</Card>',
      '',
      '```bash theme={null}',
      'curl -L -H "Accept: text/markdown" https://mintlify.com/docs/ai/markdown-export',
      '```',
      '',
      '<Visibility for="agents">',
      '  To create an account, call `POST /v1/accounts`.',
      '</Visibility>',
    ].join('\n');
    const c = cleanServedMarkdown(raw);
    expect(c.markdown).not.toContain('import {');
    expect(c.markdown).not.toContain('export const');
    expect(c.markdown).not.toContain('className');
    expect(c.markdown).not.toContain('<PreviewButton');
    expect(c.markdown).not.toContain('<Card');
    expect(c.markdown).not.toContain('theme={null}');
    expect(c.markdown).toContain('Open this page as Markdown');
    expect(c.markdown).toContain('Inside the card.');
    expect(c.markdown).toContain('```bash\ncurl -L -H "Accept: text/markdown"');
    expect(c.markdown).toContain('call `POST /v1/accounts`');
    expect(c.markdown).toContain('Markdown provides structured text');
    expect(c.markdown.startsWith('# Markdown export')).toBe(true);
  });

  it('parseServedMarkdown records x-markdown-tokens / content-signal and marks the parser', () => {
    const doc = parseServedMarkdown(
      enc('---\ntitle: Doc Title\n---\n\n# Heading\n\nSome content that is long enough to keep.'),
      {
        url: 'https://docs.example/p',
        headers: new Headers({
          'x-markdown-tokens': '4099',
          'content-signal': 'ai-train=yes, search=yes, ai-input=yes',
        }),
      },
    );
    expect(doc?.parser).toBe('server-markdown');
    expect(doc?.title).toBe('Doc Title');
    expect(doc?.metadata?.markdownTokens).toBe(4099);
    expect(doc?.metadata?.contentSignal).toBe('ai-train=yes, search=yes, ai-input=yes');
    expect(doc?.text).not.toContain('#');
    expect(isServedMarkdown('text/markdown', 'https://x/y')).toBe(true);
    expect(isServedMarkdown('text/plain', 'https://x/README.md')).toBe(true);
    expect(isServedMarkdown('text/plain', 'https://x/notes.txt')).toBe(false);
    expect(isServedMarkdown('text/html', 'https://x/y.md')).toBe(false);
  });

  it('parseResource routes text/markdown responses through the cleaner, not Readability', async () => {
    const out = await parseResource(
      {
        url: 'https://docs.example/p',
        finalUrl: 'https://docs.example/p',
        status: 200,
        contentType: 'text/markdown',
        bytes: enc(
          '[Skip to content](#main)\n\n# Title\n\nParagraph that is comfortably long enough.',
        ),
        ms: 1,
        redirects: 0,
        headers: new Headers({ 'x-markdown-tokens': '12' }),
      },
      {},
    );
    expect(out.ok).toBe(true);
    expect(out.page?.doc.parser).toBe('server-markdown');
    expect(out.page?.doc.markdown.startsWith('# Title')).toBe(true);
    expect(out.page?.doc.metadata?.markdownTokens).toBe(12);
  });
});

// ─── C2 bot-block classifier ─────────────────────────────────────────────────

describe('bot-block classifier', () => {
  it('classifies vendors from headers/body and never retries', async () => {
    let hits = 0;
    server.use(
      http.get('https://cf.example/challenge', () => {
        hits++;
        return new HttpResponse('<html><title>Just a moment...</title></html>', {
          status: 403,
          headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' },
        });
      }),
      http.get(
        'https://cf.example/blocked',
        () =>
          new HttpResponse(
            '<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>',
            { status: 403, headers: { server: 'cloudflare' } },
          ),
      ),
      http.get(
        'https://ak.example/',
        () =>
          new HttpResponse(
            '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>You don\'t have permission to access "http://ak.example/" on this server.<P>Reference&#32;#18.4d1d1002.1700000000.1a2b3c</BODY></HTML>',
            { status: 403, headers: { server: 'AkamaiGHost' } },
          ),
      ),
      http.get(
        'https://dd.example/',
        () =>
          new HttpResponse('<html><body>blocked</body></html>', {
            status: 403,
            headers: { 'x-datadome': 'protected' },
          }),
      ),
      http.get(
        'https://px.example/',
        () =>
          new HttpResponse('<html><script>window._pxAppId="PX1234";</script></html>', {
            status: 403,
          }),
      ),
      http.get(
        'https://imp.example/',
        () =>
          new HttpResponse('<html><iframe src="/_Incapsula_Resource?x=1"></iframe></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
      http.get(
        'https://pay.example/',
        () =>
          new HttpResponse('payment required', {
            status: 402,
            headers: { 'crawler-price': 'USD 0.01' },
          }),
      ),
      http.get('https://plain.example/', () => new HttpResponse('nope', { status: 403 })),
    );
    const f = fetcher({ retries: 3 });
    await expect(f.fetch('https://cf.example/challenge')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_BOT',
      retryable: false,
      details: { vendor: 'cloudflare', status: 403 },
    });
    expect(hits).toBe(1); // no retries for a challenge
    await expect(f.fetch('https://cf.example/blocked')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_BOT',
      details: { vendor: 'cloudflare' },
    });
    await expect(f.fetch('https://ak.example/')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_BOT',
      details: { vendor: 'akamai' },
    });
    await expect(f.fetch('https://dd.example/')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_BOT',
      details: { vendor: 'datadome' },
    });
    await expect(f.fetch('https://px.example/')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_BOT',
      details: { vendor: 'perimeterx' },
    });
    // 200 with a tiny interstitial body is still a block
    await expect(f.fetch('https://imp.example/')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_BOT',
      details: { vendor: 'imperva', status: 200 },
    });
    await expect(f.fetch('https://pay.example/')).rejects.toMatchObject({
      code: 'FETCH_PAYMENT_REQUIRED',
      retryable: false,
      details: { vendor: 'cloudflare-pay-per-crawl', price: 'USD 0.01' },
    });
    // an ordinary 403 stays FETCH_HTTP_ERROR
    await expect(f.fetch('https://plain.example/')).rejects.toMatchObject({
      code: 'FETCH_HTTP_ERROR',
    });
  });
});

// ─── C4 early abort on non-content responses + maxHtmlBytes ─────────────────

describe('early abort on non-content responses', () => {
  it('rejects media/archives from headers without reading the body', async () => {
    let pulls = 0;
    let cancelled = false;
    server.use(
      http.get('https://bin.example/photo', () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(1024));
          },
          cancel() {
            cancelled = true;
          },
        });
        return new HttpResponse(stream, { headers: { 'content-type': 'image/png' } });
      }),
      http.get(
        'https://bin.example/archive.zip',
        () => new HttpResponse('PK...', { headers: { 'content-type': 'application/zip' } }),
      ),
      http.get(
        'https://bin.example/app.js',
        () =>
          new HttpResponse('console.log(1)', {
            headers: { 'content-type': 'application/javascript' },
          }),
      ),
      http.get(
        'https://bin.example/paper.pdf',
        () =>
          new HttpResponse('%PDF-1.7 fake', {
            headers: { 'content-type': 'application/octet-stream' },
          }),
      ),
      http.get(
        'https://bin.example/blob',
        () =>
          new HttpResponse(new Uint8Array([0, 1, 2, 3, 0, 0, 7, 8, 9]), {
            headers: { 'content-type': 'application/octet-stream' },
          }),
      ),
      http.get(
        'https://bin.example/unlabelled-html',
        () =>
          new HttpResponse('<!doctype html><html><body>hello there world</body></html>', {
            headers: { 'content-type': 'application/octet-stream' },
          }),
      ),
    );
    const f = fetcher();
    await expect(f.fetch('https://bin.example/photo')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT_TYPE',
      details: { contentType: 'image/png', via: 'header' },
    });
    // The stream is infinite: reading it would have ended in FETCH_TOO_LARGE, not a header reject.
    await new Promise((r) => setTimeout(r, 20));
    expect(pulls).toBeLessThan(8);
    void cancelled;
    await expect(f.fetch('https://bin.example/archive.zip')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT_TYPE',
    });
    await expect(f.fetch('https://bin.example/app.js')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT_TYPE',
    });
    // octet-stream: sniffed, PDF/HTML pass, binary garbage does not
    const pdf = await f.fetch('https://bin.example/paper.pdf');
    expect(new TextDecoder().decode(pdf.bytes)).toContain('%PDF-1.7');
    const html = await f.fetch('https://bin.example/unlabelled-html');
    expect(new TextDecoder().decode(html.bytes)).toContain('hello there world');
    await expect(f.fetch('https://bin.example/blob')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT_TYPE',
      details: { via: 'sniff' },
    });
  });

  it('caps textual bodies at maxHtmlBytes but PDFs at maxBytes', async () => {
    server.use(
      http.get(
        'https://big.example/page.html',
        () =>
          new HttpResponse(`<html>${'x'.repeat(30_000)}</html>`, {
            headers: { 'content-type': 'text/html' },
          }),
      ),
      http.get(
        'https://big.example/doc.pdf',
        () =>
          new HttpResponse(`%PDF-1.7 ${'y'.repeat(30_000)}`, {
            headers: { 'content-type': 'application/pdf' },
          }),
      ),
    );
    const f = fetcher({ maxBytes: 50_000, maxHtmlBytes: 10_000 });
    await expect(f.fetch('https://big.example/page.html')).rejects.toMatchObject({
      code: 'FETCH_TOO_LARGE',
      details: { cap: 'maxHtmlBytes' },
    });
    const pdf = await f.fetch('https://big.example/doc.pdf');
    expect(pdf.bytes.byteLength).toBeGreaterThan(30_000);
  });
});

// ─── C10 Content-Signal etiquette ────────────────────────────────────────────

describe('content signals', () => {
  it('parses Content-Signal from robots.txt groups (specific group before *)', () => {
    const groups = parseContentSignalGroups(
      [
        '# comment',
        'User-agent: *',
        'Content-signal: search=no, ai-train=no',
        'Disallow: /',
        '',
        'User-agent: WebVector',
        'User-Agent: OtherBot',
        'Content-Signal: search=yes, ai-input=yes',
        'Allow: /',
      ].join('\n'),
    );
    expect(groups).toHaveLength(2);
    expect(contentSignalFor(groups, 'WebVector')).toBe('search=yes, ai-input=yes');
    expect(contentSignalFor(groups, 'Googlebot')).toBe('search=no, ai-train=no');
    const sig = parseContentSignal('search=no, ai-train=no', 'robots');
    expect(sig).toMatchObject({ search: false, aiTrain: false, source: 'robots' });
    expect(sig.aiInput).toBeUndefined();
  });

  it('respect: refuses ai-input=no from robots.txt or the header; record: attaches the signal', async () => {
    server.use(
      http.get('https://sig.example/robots.txt', () =>
        HttpResponse.text('User-agent: *\nContent-Signal: search=yes, ai-input=no\nAllow: /\n', {
          headers: { 'content-type': 'text/plain' },
        }),
      ),
      http.get('https://sig.example/page', () =>
        HttpResponse.text('# Page\n\nSome content that is long enough to matter here.', {
          headers: { 'content-type': 'text/markdown' },
        }),
      ),
      http.get('https://hdr.example/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('https://hdr.example/page', () =>
        HttpResponse.text('<html><body><p>hello world hello world hello world</p></body></html>', {
          headers: {
            'content-type': 'text/html',
            'content-signal': 'ai-train=no, search=yes, ai-input=no',
          },
        }),
      ),
      http.get('https://ok.example/robots.txt', () =>
        HttpResponse.text('User-agent: *\nContent-Signal: search=yes, ai-train=no\n', {
          headers: { 'content-type': 'text/plain' },
        }),
      ),
      http.get('https://ok.example/page', () =>
        HttpResponse.text('# Fine\n\nThis page allows ai-input by omission (no preference).', {
          headers: { 'content-type': 'text/markdown' },
        }),
      ),
    );
    const respect = fetcher({ respectRobotsTxt: true, userAgent: 'WebVector/0.1' });
    await expect(respect.fetch('https://sig.example/page')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_CONTENT_SIGNAL',
      details: { source: 'robots' },
    });
    await expect(respect.fetch('https://hdr.example/page')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_CONTENT_SIGNAL',
      details: { source: 'header' },
    });
    const ok = await respect.fetch('https://ok.example/page');
    expect(ok.contentSignal).toMatchObject({ search: true, aiTrain: false, source: 'robots' });

    const record = fetcher({
      respectRobotsTxt: true,
      userAgent: 'WebVector/0.1',
      contentSignals: 'record',
    });
    const r = await record.fetch('https://sig.example/page');
    expect(r.contentSignal).toMatchObject({ aiInput: false, source: 'robots' });
    const h = await record.fetch('https://hdr.example/page');
    expect(h.contentSignal).toMatchObject({ aiInput: false, aiTrain: false, source: 'header' });

    const ignore = fetcher({
      respectRobotsTxt: true,
      userAgent: 'WebVector/0.1',
      contentSignals: 'ignore',
    });
    expect((await ignore.fetch('https://sig.example/page')).contentSignal).toBeUndefined();

    // The signal is copied onto the parsed document.
    const out = await parseResource(r, {});
    expect(out.page?.doc.contentSignal?.aiInput).toBe(false);
  });
});

// ─── C11 URL hygiene + text-fragment hint ────────────────────────────────────

describe('url hygiene', () => {
  it('unwraps redirect wrappers, folds AMP/mobile variants, keeps the text fragment', () => {
    expect(
      cleanUrl('https://www.google.com/url?q=https://example.com/a%3Fx%3D1&sa=U&ved=abc').url,
    ).toBe('https://example.com/a?x=1');
    expect(cleanUrl('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fp&h=AT').url).toBe(
      'https://example.com/p',
    );
    expect(cleanUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fq&rut=1').url).toBe(
      'https://example.com/q',
    );
    expect(cleanUrl('https://amp.theguardian.com/world/2026/article').url).toBe(
      'https://theguardian.com/world/2026/article',
    );
    expect(cleanUrl('https://www.example.com/news/story/amp/').url).toBe(
      'https://www.example.com/news/story',
    );
    expect(cleanUrl('https://www.example.com/news/story?amp=1&id=7').url).toBe(
      'https://www.example.com/news/story?id=7',
    );
    expect(cleanUrl('https://www.example.com/news/story?outputType=amp').url).toBe(
      'https://www.example.com/news/story',
    );
    expect(cleanUrl('https://www.example.com/news/story.amp.html').url).toBe(
      'https://www.example.com/news/story.html',
    );
    expect(
      cleanUrl('https://www-example-com.cdn.ampproject.org/c/s/www.example.com/news/story?x=1').url,
    ).toBe('https://www.example.com/news/story?x=1');
    expect(cleanUrl('https://en.m.wikipedia.org/wiki/Okapi_BM25').url).toBe(
      'https://en.wikipedia.org/wiki/Okapi_BM25',
    );
    const tf = cleanUrl(
      'https://example.com/doc#:~:text=reciprocal%20rank%20fusion&text=prefix-,start%20phrase,end%20phrase,-suffix',
    );
    expect(tf.url).toBe('https://example.com/doc');
    expect(tf.textFragment).toBe('reciprocal rank fusion … start phrase … end phrase');
    expect(tf.rewritten).toBe(false);
    // untouched URLs
    expect(cleanUrl('https://amp.dev/documentation/').url).toBe('https://amp.dev/documentation/');
    expect(cleanUrl('https://www.google.com/search?q=cats').url).toBe(
      'https://www.google.com/search?q=cats',
    );
    // canonical dedupe key folds the same variants
    expect(canonicalizeUrl('https://en.m.wikipedia.org/wiki/X?utm_source=a')).toBe(
      canonicalizeUrl('https://en.wikipedia.org/wiki/X'),
    );
    expect(normalizeUrl('https://www.google.com/url?q=https://example.com/a')).toBe(
      'https://example.com/a',
    );
  });

  it('fetcher applies hygiene before robots/fetch and passes the text fragment through', async () => {
    let hit = '';
    server.use(
      http.get('https://target.example/page', ({ request }) => {
        hit = request.url;
        return HttpResponse.text(
          '# Target\n\nThe page body, long enough for a document to exist.',
          {
            headers: { 'content-type': 'text/markdown' },
          },
        );
      }),
    );
    const r = await fetcher().fetch(
      'https://www.google.com/url?q=https://target.example/page%23:~:text=page%2520body&sa=U',
    );
    expect(hit).toBe('https://target.example/page');
    expect(r.url).toBe('https://target.example/page');
    expect(r.textFragment).toBe('page body');
    const out = await parseResource(r, {});
    expect(out.page?.doc.textFragment).toBe('page body');
  });
});

// ─── C5 / C14 fast paths ─────────────────────────────────────────────────────

const FIX = new URL('./fixtures/fast-paths/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIX), 'utf8');
const json = (name: string, init?: ResponseInit) =>
  new HttpResponse(fixture(name), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) },
  });

describe('fast paths', () => {
  it('selects by URL and honours the enable list', () => {
    expect(selectFastPath('https://arxiv.org/abs/1706.03762')?.id).toBe('arxiv');
    expect(selectFastPath('https://arxiv.org/abs/hep-th/9901001v2')?.id).toBe('arxiv');
    expect(selectFastPath('https://arxiv.org/list/cs.AI/recent')).toBeUndefined();
    expect(selectFastPath('https://github.com/octo/repo')?.id).toBe('github-readme');
    expect(selectFastPath('https://github.com/octo/repo/blob/main/docs/x.md')?.id).toBe(
      'github-blob',
    );
    expect(selectFastPath('https://github.com/octo/repo/issues/42')?.id).toBe('github-issue');
    expect(selectFastPath('https://github.com/octo/repo/pull/7')?.id).toBe('github-issue');
    expect(selectFastPath('https://github.com/topics/rag')).toBeUndefined();
    expect(selectFastPath('https://docs.google.com/document/d/abc_DEF-123/edit')?.id).toBe(
      'google-docs',
    );
    expect(selectFastPath('https://www.npmjs.com/package/@scope/name')?.id).toBe('npm');
    expect(selectFastPath('https://pypi.org/project/requests/')?.id).toBe('pypi');
    expect(selectFastPath('https://news.ycombinator.com/item?id=1')?.id).toBe('hackernews');
    expect(selectFastPath('https://stackoverflow.com/questions/11227809/why')?.id).toBe(
      'stackexchange',
    );
    expect(selectFastPath('https://unix.stackexchange.com/questions/1/x')?.id).toBe(
      'stackexchange',
    );
    expect(selectFastPath('https://example.com/')).toBeUndefined();
    expect(selectFastPath('https://arxiv.org/abs/1706.03762', false)).toBeUndefined();
    expect(selectFastPath('https://arxiv.org/abs/1706.03762', ['npm'])).toBeUndefined();
    expect(selectFastPath('https://arxiv.org/abs/1706.03762', ['arxiv'])?.id).toBe('arxiv');
    expect(stackExchangeSite('meta.stackoverflow.com')).toBe('meta.stackoverflow');
    expect(stackExchangeSite('meta.unix.stackexchange.com')).toBe('meta.unix');
    expect(stackExchangeSite('es.stackoverflow.com')).toBe('es.stackoverflow');
    expect(stackExchangeSite('example.com')).toBeUndefined();
  });

  it('arxiv: abs → html, falls back to pdf on 404, then to the original page', async () => {
    const calls: string[] = [];
    server.use(
      http.get('https://arxiv.org/html/1706.03762', ({ request }) => {
        calls.push(request.url);
        return HttpResponse.html(
          `<html><body><article><h1>Attention Is All You Need</h1><p>${'The dominant sequence transduction models are based on complex recurrent networks. '.repeat(10)}</p></article></body></html>`,
        );
      }),
      http.get('https://arxiv.org/html/1409.0473', ({ request }) => {
        calls.push(request.url);
        return new HttpResponse('nf', { status: 404 });
      }),
      http.get('https://arxiv.org/pdf/1409.0473', ({ request }) => {
        calls.push(request.url);
        return new HttpResponse('nf', { status: 404 });
      }),
      http.get('https://arxiv.org/abs/1409.0473', ({ request }) => {
        calls.push(request.url);
        return HttpResponse.html(
          `<html><body><h1>Neural Machine Translation</h1><p>${'Abstract text about alignment and translation. '.repeat(10)}</p></body></html>`,
        );
      }),
    );
    const f = fetcher();
    const a = await ingestUrl('https://arxiv.org/abs/1706.03762', { fetcher: f });
    expect(a.ok).toBe(true);
    expect(a.page?.doc.url).toBe('https://arxiv.org/abs/1706.03762'); // citation keeps the original
    expect(a.page?.finalUrl).toBe('https://arxiv.org/html/1706.03762');
    expect(a.page?.doc.metadata?.fastPath).toBe('arxiv');
    expect(a.page?.doc.markdown).toContain('sequence transduction');
    const b = await ingestUrl('https://arxiv.org/abs/1409.0473', { fetcher: f });
    expect(b.ok).toBe(true);
    expect(b.page?.finalUrl).toBe('https://arxiv.org/abs/1409.0473');
    expect(b.page?.doc.metadata?.fastPath).toBeUndefined();
    expect(calls).toEqual([
      'https://arxiv.org/html/1706.03762',
      'https://arxiv.org/html/1409.0473',
      'https://arxiv.org/pdf/1409.0473',
      'https://arxiv.org/abs/1409.0473',
    ]);
    // disabled → straight to the original
    calls.length = 0;
    await ingestUrl('https://arxiv.org/abs/1409.0473', { fetcher: f, fastPaths: false });
    expect(calls).toEqual(['https://arxiv.org/abs/1409.0473']);
  });

  it('github: repo → raw README (served-markdown cleaner), blob → raw; robots of the raw host is checked', async () => {
    let robotsHits = 0;
    server.use(
      http.get('https://raw.githubusercontent.com/robots.txt', () => {
        robotsHits++;
        return new HttpResponse('nf', { status: 404 });
      }),
      http.get('https://github.com/robots.txt', () => new HttpResponse('nf', { status: 404 })),
      http.get('https://raw.githubusercontent.com/octo/repo/HEAD/README.md', () =>
        HttpResponse.text('# repo\n\nA README that is long enough to be a real document here.', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      ),
      http.get('https://raw.githubusercontent.com/octo/repo/main/docs/guide.md', () =>
        HttpResponse.text('# Guide\n\nDocs page content that is long enough to be a document.', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      ),
    );
    const f = fetcher({ respectRobotsTxt: true });
    const r = await ingestUrl('https://github.com/octo/repo', { fetcher: f });
    expect(r.ok).toBe(true);
    expect(r.page?.doc.parser).toBe('server-markdown');
    expect(r.page?.doc.title).toBe('repo');
    expect(r.page?.doc.url).toBe('https://github.com/octo/repo');
    expect(r.page?.doc.metadata?.fastPath).toBe('github-readme');
    expect(robotsHits).toBe(1);
    const b = await ingestUrl('https://github.com/octo/repo/blob/main/docs/guide.md', {
      fetcher: f,
    });
    expect(b.page?.doc.title).toBe('Guide');
    expect(b.page?.doc.metadata?.fastPath).toBe('github-blob');
  });

  it('npm: registry readme → markdown document', async () => {
    server.use(http.get('https://registry.npmjs.org/tiny-pkg', () => json('npm-tiny-pkg.json')));
    const r = await ingestUrl('https://www.npmjs.com/package/tiny-pkg', { fetcher: fetcher() });
    expect(r.ok).toBe(true);
    expect(r.page?.doc.title).toBe('tiny-pkg');
    expect(r.page?.doc.fetchedFrom).toBe('api');
    expect(r.page?.doc.markdown).toContain('latest 1.2.3');
    expect(r.page?.doc.markdown).toContain('npm i tiny-pkg');
    expect(r.page?.doc.markdown).toContain('```js');
    expect(r.page?.doc.publishedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('hacker news: Algolia item tree → threaded markdown; Firebase fallback', async () => {
    server.use(
      http.get('https://hn.algolia.com/api/v1/items/1', () => json('hn-item-1.json')),
      http.get(
        'https://hn.algolia.com/api/v1/items/2',
        () => new HttpResponse('', { status: 500 }),
      ),
      http.get('https://hacker-news.firebaseio.com/v0/item/2.json', () =>
        HttpResponse.json({
          id: 2,
          by: 'phpnode',
          title: "A Student's Guide",
          url: 'http://x.example',
          score: 16,
          time: 1160418628,
          type: 'story',
          kids: [3],
        }),
      ),
      http.get('https://hacker-news.firebaseio.com/v0/item/3.json', () =>
        HttpResponse.json({
          id: 3,
          by: 'someone',
          text: 'A comment via firebase.',
          time: 1160419000,
          type: 'comment',
        }),
      ),
    );
    const r = await ingestUrl('https://news.ycombinator.com/item?id=1', { fetcher: fetcher() });
    expect(r.ok).toBe(true);
    const md = r.page?.doc.markdown ?? '';
    expect(r.page?.doc.title).toBe('Y Combinator');
    expect(md).toContain('57 points by pg');
    expect(md).toContain('## Comments (3)');
    expect(md).toContain('**sama**');
    expect(md).toContain('> **pg**'); // nested reply as blockquote
    expect(md).toContain('"the rising star of venture capital"');
    expect(md).toContain('[a link](https://example.com/x)');
    expect(r.page?.doc.url).toBe('https://news.ycombinator.com/item?id=1');
    expect(r.page?.doc.fetchedFrom).toBe('api');
    const fb = await ingestUrl('https://news.ycombinator.com/item?id=2', { fetcher: fetcher() });
    expect(fb.ok).toBe(true);
    expect(fb.page?.doc.markdown).toContain('A comment via firebase.');
    expect(fb.page?.doc.markdown).toContain('16 points by phpnode');
  });

  it('stack exchange: question + answers with accepted first and CC BY-SA attribution; key from env; backoff → cooldown', async () => {
    const seen: string[] = [];
    server.use(
      http.get('https://api.stackexchange.com/2.3/questions/11227809', ({ request }) => {
        seen.push(request.url);
        return json('se-question-11227809.json');
      }),
      http.get('https://api.stackexchange.com/2.3/questions/11227809/answers', ({ request }) => {
        seen.push(request.url);
        return json('se-answers-11227809.json');
      }),
      http.get('https://api.stackexchange.com/2.3/questions/5', () =>
        HttpResponse.json({
          items: [
            {
              question_id: 5,
              title: 'Throttled',
              body: '<p>Body of the throttled question, long enough.</p>',
              answer_count: 0,
            },
          ],
          backoff: 12,
        }),
      ),
    );
    const r = await ingestUrl(
      'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster',
      {
        fetcher: fetcher(),
        env: { STACKEXCHANGE_KEY: 'k123' },
      },
    );
    expect(r.ok).toBe(true);
    const md = r.page?.doc.markdown ?? '';
    expect(r.page?.doc.title).toBe(
      'Why is processing a sorted array faster than an unsorted array?',
    );
    expect(md).toContain('## Question (score 27545) — asked by GManNickG');
    expect(md).toContain('```');
    expect(md).toContain('std::sort(data, data + arraySize);');
    expect(md.indexOf('### Answer (score 35295, accepted) — by Mysticial')).toBeGreaterThan(0);
    expect(md.indexOf('### Answer (score 35295, accepted)')).toBeLessThan(
      md.indexOf('### Answer (score 4600)'),
    );
    expect(md).toContain('licensed under CC BY-SA 4.0');
    expect(seen[0]).toContain('site=stackoverflow');
    expect(seen[0]).toContain('filter=withbody');
    expect(seen[0]).toContain('key=k123');
    expect(seen[1]).toContain('/answers?site=stackoverflow');
    // backoff → the fast path cools down; the next SO URL goes to the normal fetch (robots-blocked here → failure)
    server.use(
      http.get('https://stackoverflow.com/robots.txt', () =>
        HttpResponse.text('User-agent: *\nDisallow: /\n', {
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    );
    const t = await ingestUrl('https://stackoverflow.com/questions/5/throttled', {
      fetcher: fetcher({ respectRobotsTxt: true }),
    });
    expect(t.ok).toBe(true);
    expect(t.page?.doc.markdown).toContain('Throttled');
    expect(selectFastPath('https://stackoverflow.com/questions/6/x')).toBeUndefined(); // cooling down
    const blocked = await ingestUrl('https://stackoverflow.com/questions/6/x', {
      fetcher: fetcher({ respectRobotsTxt: true }),
    });
    expect(blocked.failure?.code).toBe('FETCH_BLOCKED_ROBOTS');
    cooldownFastPath('stackexchange', 0);
    expect(selectFastPath('https://stackoverflow.com/questions/6/x')?.id).toBe('stackexchange');
  });

  it('github issue: REST issue + comments, token from env, rate-limit → cooldown', async () => {
    const auth: (string | null)[] = [];
    server.use(
      http.get('https://api.github.com/repos/octo/repo/issues/42', ({ request }) => {
        auth.push(request.headers.get('authorization'));
        return json('gh-issue-42.json', { headers: { 'x-ratelimit-remaining': '58' } });
      }),
      http.get('https://api.github.com/repos/octo/repo/issues/42/comments', () =>
        json('gh-issue-42-comments.json'),
      ),
      http.get('https://api.github.com/repos/octo/repo/issues/43', () =>
        json('gh-issue-42.json', {
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          },
        }),
      ),
    );
    const r = await ingestUrl('https://github.com/octo/repo/issues/42', {
      fetcher: fetcher(),
      env: { GITHUB_TOKEN: 'ghp_test' },
    });
    expect(r.ok).toBe(true);
    const md = r.page?.doc.markdown ?? '';
    expect(r.page?.doc.title).toContain('Fetcher retries challenge pages forever');
    expect(md).toContain('Issue octo/repo#42 · open · opened by alice');
    expect(md).toContain('labels: bug, ingest');
    expect(md).toContain('## Comments (2)');
    expect(md).toContain('### bob · 2026-08-01');
    expect(md).toContain('cf-mitigated: challenge');
    expect(auth[0]).toBe('Bearer ghp_test');
    await ingestUrl('https://github.com/octo/repo/issues/43', { fetcher: fetcher(), env: {} });
    expect(selectFastPath('https://github.com/octo/repo/issues/44')).toBeUndefined();
    cooldownFastPath('github-issue', 0);
  });

  it('registerFastPath adds a custom path', async () => {
    registerFastPath({
      id: 'custom-test',
      description: 'test',
      match: (u) => u.hostname === 'custom.example',
      resolve: async (ctx) => ({
        url: ctx.url.toString(),
        finalUrl: 'https://custom.example/api',
        status: 200,
        contentType: 'text/markdown',
        bytes: new TextEncoder().encode('# Custom\n\nRendered by a custom fast path, long enough.'),
        ms: 1,
        redirects: 0,
        headers: new Headers(),
        fastPath: { id: 'custom-test', api: true },
      }),
    });
    const r = await ingestUrl('https://custom.example/thing', { fetcher: fetcher() });
    expect(r.page?.doc.title).toBe('Custom');
    expect(r.page?.doc.metadata?.fastPath).toBe('custom-test');
  });
});

// ─── C7 provider-content quality gate ────────────────────────────────────────

describe('provider-content quality gate', () => {
  const good = `${'A proper paragraph of extracted article text that reads like prose. '.repeat(12)}\n\nAnd a second paragraph that ends cleanly.`;
  it('assessProviderContent accepts prose and rejects short / html / truncated / boilerplate', () => {
    expect(assessProviderContent(good).ok).toBe(true);
    expect(assessProviderContent('too short')).toMatchObject({ ok: false, reason: 'short' });
    expect(
      assessProviderContent(
        `<html><body><div><p>${'x '.repeat(200)}</p><div><span>a</span><a href="#">b</a></div><br><li>c</li><li>d</li></div></body></html>`,
      ),
    ).toMatchObject({ ok: false, reason: 'html' });
    // exactly 2000 chars, cut mid-sentence
    const truncated = 'The quick brown fox jumps over the lazy dog and keeps running '
      .repeat(40)
      .slice(0, 2000);
    expect(truncated.length).toBe(2000);
    expect(assessProviderContent(truncated)).toMatchObject({ ok: false, reason: 'truncated' });
    // 2000 chars but ending at a sentence boundary is fine
    const clean = `${'Sentence one is here. '.repeat(100).slice(0, 1999)}.`;
    expect(clean.length).toBe(2000);
    expect(assessProviderContent(clean).ok).toBe(true);
    expect(assessProviderContent(`${'Words in a sentence '.repeat(60)}...`)).toMatchObject({
      ok: false,
      reason: 'truncated',
    });
    const nav = Array.from({ length: 30 }, (_, i) => `[Link ${i}](https://x.example/${i})`).join(
      '\n',
    );
    expect(assessProviderContent(nav)).toMatchObject({ ok: false, reason: 'boilerplate' });
    const shortLines = Array.from({ length: 30 }, (_, i) => `Menu item ${i}`).join('\n');
    expect(assessProviderContent(shortLines)).toMatchObject({ ok: false, reason: 'boilerplate' });
  });

  it('auto: trusts good provider content, falls through to a fetch for truncated content (parser provider→fetch)', async () => {
    let fetched = 0;
    server.use(
      http.get('https://prov.example/good', () => {
        fetched++;
        return HttpResponse.html(
          `<html><head><title>Good page</title></head><body><article><h1>Good page</h1><p>${'Fetched copy of the good page. '.repeat(15)}</p></article></body></html>`,
        );
      }),
      http.get('https://prov.example/truncated', () => {
        fetched++;
        return HttpResponse.html(
          `<html><head><title>Full page</title></head><body><article><h1>Full page</h1><p>${'The complete fetched article text, not the truncated provider copy. '.repeat(15)}</p></article></body></html>`,
        );
      }),
    );
    const truncated = 'Provider text that stops mid sentence without any punctuation at all '
      .repeat(60)
      .slice(0, 4000);
    const provider = customSearchProvider('prov', async () => [
      { url: 'https://prov.example/good', title: 'Good', rank: 1, extra: { content: good } },
      {
        url: 'https://prov.example/truncated',
        title: 'Truncated',
        rank: 2,
        extra: { content: truncated },
      },
    ]);
    const make = (useProviderContent: boolean | 'auto') =>
      new WebVector(
        {
          search: { instance: provider, fallbackProviders: [] },
          embeddings: { provider: 'none' },
          ingestion: {
            respectRobotsTxt: false,
            perHostMinIntervalMs: 0,
            retries: 0,
            allowPrivateNetworks: true,
            useProviderContent,
            cache: { enabled: false },
          },
          logger: silentLogger,
        },
        { env: {} },
      );
    const parsers = new Map<string, string>();
    const wv = make('auto');
    wv.on('page:complete', ({ url, doc }) => parsers.set(url, doc.parser));
    const auto = await wv.research('article text');
    const good1 = auto.sources.find((s) => s.url.endsWith('/good'));
    const trunc = auto.sources.find((s) => s.url.endsWith('/truncated'));
    expect(good1?.status).toBe('ok');
    expect(trunc?.status).toBe('ok');
    expect(fetched).toBe(1); // only the truncated one was fetched
    expect(parsers.get('https://prov.example/good')).toBe('provider');
    expect(parsers.get('https://prov.example/truncated')).toBe('provider→fetch');
    // legacy true: provider content trusted blindly (no fetch)
    fetched = 0;
    await make(true).research('article text');
    expect(fetched).toBe(0);
    // false: always fetch
    await make(false).research('article text');
    expect(fetched).toBe(2);
  });
});

// ─── C15 Wayback fallback (opt-in) ───────────────────────────────────────────

describe('archive fallback', () => {
  const article = (t: string) =>
    `<html><head><title>${t}</title></head><body><article><h1>${t}</h1><p>${'Archived article body text that is long enough to extract. '.repeat(12)}</p></article></body></html>`;
  const availability = (ts: string | null) =>
    HttpResponse.json(
      ts
        ? {
            archived_snapshots: {
              closest: {
                available: true,
                status: '200',
                timestamp: ts,
                url: `http://web.archive.org/web/${ts}/x`,
              },
            },
          }
        : { archived_snapshots: {} },
    );

  it("'blocked': bot-walled page is served from the Wayback snapshot, marked fetchedFrom/archivedAt", async () => {
    resetArchiveFallbackState();
    const calls: string[] = [];
    server.use(
      http.get(
        'https://walled.example/post',
        () =>
          new HttpResponse('Just a moment...', {
            status: 403,
            headers: { 'cf-mitigated': 'challenge' },
          }),
      ),
      http.get('https://archive.org/wayback/available', ({ request }) => {
        calls.push(request.url);
        return availability('20260115123045');
      }),
      http.get('https://web.archive.org/web/*', ({ request }) => {
        calls.push(request.url);
        return request.url ===
          'https://web.archive.org/web/20260115123045id_/https://walled.example/post'
          ? HttpResponse.html(article('Walled post'))
          : new HttpResponse('nf', { status: 404 });
      }),
    );
    const off = await ingestUrl('https://walled.example/post', { fetcher: fetcher() });
    expect(off.failure?.code).toBe('FETCH_BLOCKED_BOT');
    expect(calls).toHaveLength(0);
    const on = await ingestUrl('https://walled.example/post', {
      fetcher: fetcher(),
      archiveFallback: 'blocked',
    });
    expect(on.ok).toBe(true);
    expect(on.page?.doc.url).toBe('https://walled.example/post');
    expect(on.page?.finalUrl).toBe(
      'https://web.archive.org/web/20260115123045id_/https://walled.example/post',
    );
    expect(on.page?.doc.fetchedFrom).toBe('archive');
    expect(on.page?.doc.archivedAt).toBe('2026-01-15T12:30:45.000Z');
    expect(on.page?.doc.metadata?.archiveUrl).toContain('web.archive.org');
    expect(on.page?.doc.markdown).toContain('Archived article body');
    expect(calls[0]).toContain('wayback/available?url=https%3A%2F%2Fwalled.example%2Fpost');
  }, 15_000);

  it("'blocked' covers 404 but not 500; 'always' covers 500; robots refusals are never archived", async () => {
    resetArchiveFallbackState();
    server.use(
      http.get('https://gone.example/old', () => new HttpResponse('nf', { status: 404 })),
      http.get('https://down.example/x', () => new HttpResponse('err', { status: 500 })),
      http.get('https://robots.example/robots.txt', () =>
        HttpResponse.text('User-agent: *\nDisallow: /\n', {
          headers: { 'content-type': 'text/plain' },
        }),
      ),
      http.get('https://archive.org/wayback/available', () => availability('20250101000000')),
      http.get('https://web.archive.org/web/*', ({ request }) => {
        if (request.url.endsWith('id_/https://gone.example/old'))
          return HttpResponse.html(article('Old page'));
        if (request.url.endsWith('id_/https://down.example/x'))
          return HttpResponse.html(article('Down page'));
        return new HttpResponse('nf', { status: 404 });
      }),
    );
    const gone = await ingestUrl('https://gone.example/old', {
      fetcher: fetcher(),
      archiveFallback: 'blocked',
    });
    expect(gone.ok).toBe(true);
    expect(gone.page?.doc.title).toBe('Old page');
    const down = await ingestUrl('https://down.example/x', {
      fetcher: fetcher(),
      archiveFallback: 'blocked',
    });
    expect(down.ok).toBe(false);
    const downAlways = await ingestUrl('https://down.example/x', {
      fetcher: fetcher(),
      archiveFallback: 'always',
    });
    expect(downAlways.ok).toBe(true);
    expect(downAlways.page?.doc.title).toBe('Down page');
    const robots = await ingestUrl('https://robots.example/p', {
      fetcher: fetcher({ respectRobotsTxt: true }),
      archiveFallback: 'always',
    });
    expect(robots.failure?.code).toBe('FETCH_BLOCKED_ROBOTS');
  }, 20_000);

  it('paywalled snapshots (isAccessibleForFree:false) are refused; a 429 disables the fallback', async () => {
    resetArchiveFallbackState();
    let availabilityCalls = 0;
    server.use(
      http.get('https://paid.example/story', () => new HttpResponse('nf', { status: 404 })),
      http.get('https://busy.example/a', () => new HttpResponse('nf', { status: 404 })),
      http.get('https://busy.example/b', () => new HttpResponse('nf', { status: 404 })),
      http.get('https://archive.org/wayback/available', ({ request }) => {
        availabilityCalls++;
        const url = new URL(request.url).searchParams.get('url') ?? '';
        if (url.startsWith('https://busy.example/'))
          return new HttpResponse('slow down', { status: 429 });
        return availability('20240101000000');
      }),
      http.get('https://web.archive.org/web/*', () =>
        HttpResponse.html(
          `<html><head><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false,"headline":"Paid"}</script></head><body><article><h1>Paid</h1><p>${'Paywalled text. '.repeat(30)}</p></article></body></html>`,
        ),
      ),
    );
    const paid = await ingestUrl('https://paid.example/story', {
      fetcher: fetcher(),
      archiveFallback: 'blocked',
    });
    expect(paid.ok).toBe(false);
    expect(paid.failure?.code).toBe('FETCH_HTTP_ERROR');
    const a = await ingestUrl('https://busy.example/a', {
      fetcher: fetcher(),
      archiveFallback: 'blocked',
    });
    expect(a.ok).toBe(false);
    expect(availabilityCalls).toBe(2);
    const b = await ingestUrl('https://busy.example/b', {
      fetcher: fetcher(),
      archiveFallback: 'blocked',
    });
    expect(b.ok).toBe(false);
    expect(availabilityCalls).toBe(2); // disabled after the 429 — no further lookups
    resetArchiveFallbackState();
  }, 20_000);
});
