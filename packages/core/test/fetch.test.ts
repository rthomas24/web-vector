/**
 * Fetch-robustness stream: markdown-first negotiation, bot-block classification, early aborts,
 * Content-Signal etiquette, URL hygiene, fast paths, provider-content gate, archive fallback.
 */
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { acceptHeaderFor, Fetcher, parseContentSignal } from '../src/ingest/fetcher.js';
import { parseResource } from '../src/ingest/index.js';
import {
  cleanServedMarkdown,
  isServedMarkdown,
  parseServedMarkdown,
} from '../src/ingest/markdown-clean.js';
import { contentSignalFor, parseContentSignalGroups } from '../src/ingest/robots.js';

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
