/** Render hook (ingestion.render): adapters, budget, SSRF guard, ingestUrl wiring. */
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Fetcher } from '../src/ingest/fetcher.js';
import { ingestUrl } from '../src/ingest/index.js';
import {
  BrowserlessRenderProvider,
  CloudflareRenderProvider,
  createRenderProvider,
  RenderBudget,
  type RenderHook,
  type RenderProvider,
  renderWithHook,
} from '../src/ingest/render.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const publicResolve = async () => ['93.184.216.34'];
const fetcher = () =>
  new Fetcher({
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
  });

const SHELL = `<!doctype html><html><head><title>App</title></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div><script src="/static/js/main.abc123.js"></script></body></html>`;
const RENDERED = `<!doctype html><html><head><title>Rendered</title></head><body><main><article><h1>Rendered page</h1>${'<p>Client-rendered paragraph with enough words to be real content for the parser.</p>'.repeat(8)}</article></main></body></html>`;

const hook = (provider: RenderProvider, over: Partial<RenderHook> = {}): RenderHook => ({
  provider,
  when: 'needs-js',
  budget: new RenderBudget(2),
  timeoutMs: 2000,
  resolve: publicResolve,
  ...over,
});

describe('render adapters', () => {
  it('cloudflare posts {url} with a bearer token and returns result markdown', async () => {
    let seen: any;
    server.use(
      http.post(
        'https://api.cloudflare.com/client/v4/accounts/acct1/browser-rendering/markdown',
        async ({ request }) => {
          seen = { auth: request.headers.get('authorization'), body: await request.json() };
          return HttpResponse.json({ success: true, result: '# Hello\n\nrendered' });
        },
      ),
    );
    const p = new CloudflareRenderProvider({ accountId: 'acct1', apiToken: 'tok' });
    const r = await p.render('https://app.example/x', {});
    expect(r.markdown).toBe('# Hello\n\nrendered');
    expect(seen.auth).toBe('Bearer tok');
    expect(seen.body).toEqual({ url: 'https://app.example/x' });
  });
  it('cloudflare maps API errors', async () => {
    server.use(
      http.post(
        'https://api.cloudflare.com/client/v4/accounts/acct1/browser-rendering/markdown',
        () =>
          HttpResponse.json(
            { success: false, errors: [{ code: 10000, message: 'Auth error' }] },
            { status: 403 },
          ),
      ),
    );
    await expect(
      new CloudflareRenderProvider({ accountId: 'acct1', apiToken: 'bad' }).render(
        'https://a.example/',
        {},
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });
  it('browserless posts to /content?token= and returns html', async () => {
    let seen: any;
    server.use(
      http.post('https://chrome.example/content', async ({ request }) => {
        seen = {
          token: new URL(request.url).searchParams.get('token'),
          body: await request.json(),
        };
        return new HttpResponse(RENDERED, { headers: { 'content-type': 'text/html' } });
      }),
    );
    const p = new BrowserlessRenderProvider({ token: 't0k', baseUrl: 'https://chrome.example/' });
    const r = await p.render('https://app.example/x', {});
    expect(r.html).toContain('Rendered page');
    expect(seen.token).toBe('t0k');
    expect(seen.body.url).toBe('https://app.example/x');
  });
  it('createRenderProvider reads env and rejects incomplete config', () => {
    expect(createRenderProvider(undefined)).toBeUndefined();
    expect(createRenderProvider({ when: 'never', provider: 'cloudflare' })).toBeUndefined();
    expect(() => createRenderProvider({ when: 'needs-js', provider: 'cloudflare' }, {})).toThrow(
      /credentials/,
    );
    expect(
      createRenderProvider(
        { when: 'needs-js', provider: 'cloudflare' },
        { CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 'b' },
      )?.id,
    ).toBe('cloudflare');
    expect(
      createRenderProvider(
        { when: 'needs-js', provider: 'browserless' },
        { BROWSERLESS_TOKEN: 'x' },
      )?.id,
    ).toBe('browserless');
    expect(() => createRenderProvider({ when: 'needs-js', provider: 'custom' }, {})).toThrow(
      /instance/,
    );
    const inst: RenderProvider = { id: 'mine', render: async () => ({ html: '<p>x</p>' }) };
    expect(createRenderProvider({ when: 'needs-js', provider: 'custom', instance: inst })).toBe(
      inst,
    );
  });
});

describe('renderWithHook', () => {
  it('enforces the per-run budget and the SSRF guard', async () => {
    const calls: string[] = [];
    const p: RenderProvider = {
      id: 'mem',
      render: async (u) => {
        calls.push(u);
        return { html: RENDERED };
      },
    };
    const h = hook(p, { budget: new RenderBudget(1) });
    await renderWithHook(h, 'https://a.example/1');
    await expect(renderWithHook(h, 'https://a.example/2')).rejects.toMatchObject({
      code: 'PARSE_NEEDS_JS',
    });
    expect(calls).toEqual(['https://a.example/1']);
    await expect(renderWithHook(hook(p), 'http://127.0.0.1/admin')).rejects.toMatchObject({
      code: 'FETCH_BLOCKED_SSRF',
    });
    await expect(
      renderWithHook(hook(p, { resolve: async () => ['10.0.0.1'] }), 'https://internal.example/'),
    ).rejects.toMatchObject({ code: 'FETCH_BLOCKED_SSRF' });
  });
  it('rejects empty results and honours the timeout', async () => {
    await expect(
      renderWithHook(hook({ id: 'e', render: async () => ({}) }), 'https://a.example/'),
    ).rejects.toMatchObject({ code: 'PARSE_EMPTY' });
    const slow: RenderProvider = {
      id: 'slow',
      render: (_u, o) =>
        new Promise((_res, rej) =>
          o.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
        ),
    };
    await expect(
      renderWithHook(hook(slow, { timeoutMs: 20 }), 'https://a.example/'),
    ).rejects.toThrow(/aborted/);
  });
});

describe('ingestUrl + render hook', () => {
  it('renders a JS shell (needs-js) and parses html or markdown results; caps by budget', async () => {
    server.use(http.get('https://app.example/*', () => HttpResponse.html(SHELL)));
    const htmlProvider: RenderProvider = { id: 'h', render: async () => ({ html: RENDERED }) };
    const h = hook(htmlProvider, { budget: new RenderBudget(1) });
    const a = await ingestUrl('https://app.example/one', { fetcher: fetcher(), render: h });
    expect(a.ok).toBe(true);
    expect(a.rendered).toBe(true);
    expect(a.page?.doc.parser).toMatch(/^render:h\//);
    expect(a.page?.doc.markdown).toContain('Client-rendered paragraph');
    expect(a.page?.doc.url).toBe('https://app.example/one');
    // budget spent → original failure returned, with a note
    const b = await ingestUrl('https://app.example/two', { fetcher: fetcher(), render: h });
    expect(b.ok).toBe(false);
    expect(b.failure?.code).toBe('PARSE_NEEDS_JS');
    expect(b.failure?.message).toMatch(/budget/);
    const mdProvider: RenderProvider = {
      id: 'm',
      render: async () => ({
        markdown: `# Title\n\n${'Rendered markdown sentence here. '.repeat(20)}`,
      }),
    };
    const m = await ingestUrl('https://app.example/three', {
      fetcher: fetcher(),
      render: hook(mdProvider),
    });
    expect(m.ok).toBe(true);
    expect(m.page?.doc.title).toBe('Title');
    expect(m.page?.doc.parser).toBe('render:m/text');
  });
  it('does not render for a normal page, for when=never, or when the fetch fails without blocked mode', async () => {
    let calls = 0;
    const p: RenderProvider = {
      id: 'c',
      render: async () => {
        calls++;
        return { html: RENDERED };
      },
    };
    server.use(
      http.get('https://ok.example/', () => HttpResponse.html(RENDERED)),
      http.get('https://app.example/', () => HttpResponse.html(SHELL)),
      http.get('https://blocked.example/', () => new HttpResponse('nope', { status: 403 })),
    );
    expect(
      (await ingestUrl('https://ok.example/', { fetcher: fetcher(), render: hook(p) })).rendered,
    ).toBeUndefined();
    const never = await ingestUrl('https://app.example/', {
      fetcher: fetcher(),
      render: hook(p, { when: 'never' }),
    });
    expect(never.ok).toBe(false);
    const blockedNoMode = await ingestUrl('https://blocked.example/', {
      fetcher: fetcher(),
      render: hook(p),
    });
    expect(blockedNoMode.ok).toBe(false);
    expect(calls).toBe(0);
    const blocked = await ingestUrl('https://blocked.example/', {
      fetcher: fetcher(),
      render: hook(p, { when: 'blocked' }),
    });
    expect(blocked.ok).toBe(true);
    expect(blocked.rendered).toBe(true);
    expect(calls).toBe(1);
  });
});
