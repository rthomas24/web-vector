/**
 * Fetch-robustness stream: markdown-first negotiation, bot-block classification, early aborts,
 * Content-Signal etiquette, URL hygiene, fast paths, provider-content gate, archive fallback.
 */
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { acceptHeaderFor, Fetcher } from '../src/ingest/fetcher.js';
import { parseResource } from '../src/ingest/index.js';
import {
  cleanServedMarkdown,
  isServedMarkdown,
  parseServedMarkdown,
} from '../src/ingest/markdown-clean.js';

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
