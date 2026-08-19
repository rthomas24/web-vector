import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { customEmbeddingProvider } from '../src/embeddings/base.js';
import { WebVectorError } from '../src/errors.js';
import { anthropicTools, runAnthropicTool } from '../src/integrations/anthropic.js';
import { openaiTools, runOpenAITool } from '../src/integrations/openai.js';
import { renderMarkdown } from '../src/pipeline/format.js';
import {
  webFetchToolDefinition,
  webResearchInputSchema,
  webResearchToolDefinition,
  webSearchToolDefinition,
} from '../src/pipeline/tool.js';
import { mergeSearchResults, WebVector } from '../src/pipeline/webvector.js';
import { customSearchProvider } from '../src/search/providers.js';
import { silentLogger } from '../src/util/logger.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Toy embedder: bag-of-keywords → 6 dims (deterministic, meaningful similarity). */
const KEYS = ['fusion', 'rank', 'banana', 'weather', 'python', 'formula'];
const toyEmbedder = customEmbeddingProvider(
  'toy',
  'toy-1',
  async (texts) =>
    texts.map((t) => {
      const l = t.toLowerCase();
      const v = KEYS.map((k) => (l.split(k).length - 1) * 1.0 + 0.01);
      return v;
    }),
  { dimensions: 6, limits: { maxBatchSize: 4 } },
);

const page = (title: string, paras: string[]) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${paras.map((p) => `<p>${p} ${'Additional filler sentence to make the paragraph long enough for extraction. '.repeat(6)}</p>`).join('')}</article></body></html>`;

function mockSites() {
  server.use(
    http.get('https://rrf.example/intro', () =>
      HttpResponse.html(
        page('RRF intro', [
          'Reciprocal rank fusion combines ranked lists. The rank of each document matters.',
          'The formula for rank fusion uses 1/(k+rank).',
          'Fusion works across systems.',
        ]),
      ),
    ),
    http.get('https://fruit.example/banana', () =>
      HttpResponse.html(
        page('Bananas', ['Banana banana banana is a fruit.', 'Weather affects banana crops.']),
      ),
    ),
    http.get('https://py.example/doc', () =>
      HttpResponse.html(
        page('Python docs', [
          'Python is a programming language.',
          'The formula module in python computes things.',
        ]),
      ),
    ),
    http.get('https://down.example/x', () => new HttpResponse('nope', { status: 500 })),
    http.get('https://slow.example/x', async () => {
      await new Promise((r) => setTimeout(r, 3000));
      return HttpResponse.html(page('Slow', ['slow slow']));
    }),
    http.get('*/robots.txt', () => new HttpResponse('', { status: 404 })),
  );
}

const search = customSearchProvider('mock', async () => [
  {
    url: 'https://rrf.example/intro',
    title: 'RRF intro',
    snippet: 'Reciprocal rank fusion combines ranked lists',
    rank: 1,
  },
  { url: 'https://fruit.example/banana', title: 'Bananas', snippet: 'Banana fruit', rank: 2 },
  { url: 'https://py.example/doc', title: 'Python docs', snippet: 'python', rank: 3 },
  { url: 'https://down.example/x', title: 'Down', snippet: 'x', rank: 4 },
]);

function make(extra: ConstructorParameters<typeof WebVector>[0] = {}) {
  return new WebVector(
    {
      search: { instance: search, fallbackProviders: [] },
      embeddings: { instance: toyEmbedder },
      ingestion: {
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        timeoutMs: 1500,
        totalDeadlineMs: 2500,
        minChunkChars: 20,
        chunkSize: 80,
        allowPrivateNetworks: true,
      },
      retrieval: { maxPerSource: 3, relativeCutoff: 0, mmr: false },
      logger: silentLogger,
      ...extra,
    },
    { env: {} },
  );
}

describe('WebVector pipeline (mocked)', () => {
  it('runs end-to-end and returns cited passages, sources, failures, stats', async () => {
    mockSites();
    const wv = make();
    const events: string[] = [];
    wv.on('stage', (s) => events.push(s.stage));
    const res = await wv.research('reciprocal rank fusion formula', { topK: 4 });
    expect(res.passages.length).toBeGreaterThan(0);
    expect(res.passages[0]!.url).toBe('https://rrf.example/intro');
    expect(res.passages[0]!.text).toMatch(/fusion|rank/i);
    expect(res.passages[0]!.citation).toMatch(/^\[1\] RRF intro — https:\/\/rrf\.example\/intro$/);
    expect(res.passages.every((p) => p.score >= 0 && p.score <= 1)).toBe(true);
    expect(res.passages.map((p) => p.index)).toEqual(res.passages.map((_, i) => i + 1));
    expect(res.sources.find((s) => s.url === 'https://down.example/x')?.status).toBe('failed');
    expect(res.failures.some((f) => f.code === 'FETCH_HTTP_ERROR')).toBe(true);
    expect(res.stats.ingest.ok).toBe(3);
    expect(res.stats.embed.provider).toBe('toy');
    expect(res.stats.search.attempts[0]?.provider).toBe('mock');
    expect(res.queries[0]).toBe('reciprocal rank fusion formula');
    expect(res.markdown).toContain('# Web research: reciprocal rank fusion formula');
    expect(res.markdown).toContain('## Sources');
    expect(res.stats.retrieve.tokensReturned).toBeGreaterThan(0);
    expect(events).toEqual(['search', 'ingest', 'retrieve', 'format']);
    await wv.close();
  });
  it('honours domain filters, topK and relatedQueries', async () => {
    mockSites();
    const wv = make();
    const res = await wv.research('banana', {
      topK: 2,
      domainsAllow: ['fruit.example'],
      relatedQueries: ['banana crops weather'],
    });
    // The two banana chunks are neighbours on one page → merged into a single passage.
    expect(res.passages).toHaveLength(1);
    expect(res.passages[0]!.chunkCount).toBe(2);
    expect(res.passages.every((p) => p.url.includes('fruit.example'))).toBe(true);
    expect(res.stats.ingest.requested).toBe(1);
    expect(res.queries).toContain('banana crops weather');
    // Related queries are aspects: coverage counts passages matching each one.
    expect(res.coverage).toEqual({ 'banana crops weather': expect.any(Number) });
    expect(res.coverage!['banana crops weather']).toBeGreaterThan(0);
    await wv.close();
    const plain = make({ retrieval: { mergeAdjacent: false, mmr: false, relativeCutoff: 0 } });
    const res2 = await plain.research('banana', { topK: 2, domainsAllow: ['fruit.example'] });
    expect(res2.passages).toHaveLength(2);
    await plain.close();
  });
  it('degrades to search snippets when all fetches fail', async () => {
    server.use(
      http.get('https://*.example/*', () => new HttpResponse('x', { status: 503 })),
      http.get('*/robots.txt', () => new HttpResponse('', { status: 404 })),
    );
    const wv = make();
    const res = await wv.research('rank fusion');
    expect(res.degraded).toBe('search_only');
    expect(res.passages[0]!.fromSnippet).toBe(true);
    expect(res.failures.some((f) => f.code === 'ALL_FETCHES_FAILED')).toBe(true);
    expect(res.markdown).toContain('search snippets');
    await wv.close();
  });
  it('session mode reuses ingested pages across calls', async () => {
    mockSites();
    let fetches = 0;
    server.use(
      http.get('https://rrf.example/intro', () => {
        fetches++;
        return HttpResponse.html(
          page('RRF intro', ['Reciprocal rank fusion combines ranked lists.']),
        );
      }),
    );
    const wv = make({
      store: { mode: 'session' },
      ingestion: {
        cache: { enabled: false },
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        allowPrivateNetworks: true,
        minChunkChars: 20,
      },
    });
    const a = await wv.research('rank fusion', {
      sessionId: 'conv1',
      domainsAllow: ['rrf.example'],
    });
    const b = await wv.research('fusion formula', {
      sessionId: 'conv1',
      domainsAllow: ['rrf.example'],
    });
    expect(fetches).toBe(1);
    expect(b.sources[0]?.status).toBe('cached');
    expect(b.stats.ingest.cached).toBe(1);
    expect(a.passages.length).toBeGreaterThan(0);
    expect((await wv.listSessions()).map((s) => s.id)).toEqual(['conv1']);
    await wv.clearSession('conv1');
    expect(await wv.listSessions()).toHaveLength(0);
    await wv.close();
  });
  it('total deadline cuts stragglers', async () => {
    mockSites();
    const slowSearch = customSearchProvider('slow', async () => [
      { url: 'https://slow.example/x', title: 'Slow', rank: 1 },
      { url: 'https://rrf.example/intro', title: 'RRF intro', rank: 2 },
    ]);
    const wv = make({
      search: { instance: slowSearch, fallbackProviders: [] },
      ingestion: {
        totalDeadlineMs: 1200,
        timeoutMs: 5000,
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        allowPrivateNetworks: true,
        minChunkChars: 20,
      },
    });
    const t0 = Date.now();
    const res = await wv.research('rank fusion');
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(res.failures.some((f) => f.code === 'FETCH_TIMEOUT')).toBe(true);
    expect(res.passages.length).toBeGreaterThan(0);
    await wv.close();
  });
  it('fetch + fetchAndRetrieve + search work standalone', async () => {
    mockSites();
    const wv = make();
    const doc = await wv.fetch('https://rrf.example/intro');
    expect(doc.title).toBe('RRF intro');
    const r = await wv.fetchAndRetrieve('https://rrf.example/intro', 'formula', { topK: 1 });
    expect(r.passages).toHaveLength(1);
    expect(r.passages[0]!.text).toContain('formula');
    const s = await wv.search('x');
    expect(s).toHaveLength(4);
    await expect(wv.fetch('https://down.example/x')).rejects.toBeInstanceOf(WebVectorError);
    await wv.close();
  });
  it('attaches query-focused highlights and can render highlight-only markdown', async () => {
    mockSites();
    const wv = make({ output: { passageMode: 'highlight' } });
    const res = await wv.research('reciprocal rank fusion formula', { topK: 3 });
    const top = res.passages[0]!;
    expect(top.highlight).toBeDefined();
    expect(top.highlight!.text.length).toBeLessThanOrEqual(top.text.length);
    expect(top.text).toContain(top.highlight!.text);
    // Highlight offsets are page offsets: passage-relative slice reproduces the highlight.
    const local = top.highlight!.startOffset - top.startOffset;
    expect(top.text.slice(local, local + top.highlight!.text.length)).toBe(top.highlight!.text);
    expect(top.highlight!.text).toMatch(/fusion|rank/i);
    // highlight mode renders the window, not the whole passage
    expect(res.markdown).toContain(top.highlight!.text.split('\n')[0]);
    await wv.close();
    const off = make({ output: { highlights: false } });
    const r2 = await off.research('reciprocal rank fusion formula', { topK: 2 });
    expect(r2.passages[0]!.highlight).toBeUndefined();
    await off.close();
  });
  it('reports corroboration across domains, boosts it only when enabled, and orders by date', async () => {
    const shared =
      'Reciprocal rank fusion sums one over k plus rank across lists; the constant k is usually sixty and it dampens the effect of high ranks.';
    server.use(
      http.get('https://rrf.example/intro', () =>
        HttpResponse.html(
          `<!doctype html><html><head><title>RRF intro</title><meta property="article:published_time" content="2020-01-15"></head><body><article><h1>RRF intro</h1><p>${shared} ${'More rrf filler text about fusion. '.repeat(8)}</p></article></body></html>`,
        ),
      ),
      http.get('https://fruit.example/banana', () =>
        HttpResponse.html(
          `<!doctype html><html><head><title>Mirror</title><meta property="article:published_time" content="2025-06-01"></head><body><article><h1>Mirror</h1><p>As the docs put it: ${shared} ${'Different mirror filler words here. '.repeat(8)}</p></article></body></html>`,
        ),
      ),
      http.get('https://py.example/doc', () =>
        HttpResponse.html(
          page('Python docs', [
            'Python rank fusion is different, it merges rank lists by formula.',
          ]),
        ),
      ),
      http.get('https://down.example/x', () => new HttpResponse('nope', { status: 500 })),
      http.get('*/robots.txt', () => new HttpResponse('', { status: 404 })),
    );
    const wv = make({ retrieval: { nearDuplicateThreshold: 1, mmr: false, relativeCutoff: 0 } });
    const res = await wv.research('reciprocal rank fusion constant k', { topK: 4 });
    const rrf = res.passages.find((p) => p.url.includes('rrf.example'));
    const mirror = res.passages.find((p) => p.url.includes('fruit.example'));
    expect(rrf?.corroboration).toBe(2);
    expect(mirror?.corroboration).toBe(2);
    expect(res.passages.find((p) => p.url.includes('py.example'))?.corroboration).toBe(1);
    // Dates always show in citations when known.
    expect(rrf?.citation).toMatch(/\(2020-01-15\)$/);
    expect(res.passages[0]!.explain).toBeUndefined();
    await wv.close();

    // Recency: only with a freshness request; the 2025 mirror gets a multiplier, the 2020 page ~1.
    const wv2 = make({ retrieval: { nearDuplicateThreshold: 1, mmr: false, relativeCutoff: 0 } });
    const r2 = await wv2.research('reciprocal rank fusion constant k', {
      topK: 4,
      freshness: 'year',
      explain: true,
    });
    const m2 = r2.passages.find((p) => p.url.includes('fruit.example'))!;
    const o2 = r2.passages.find((p) => p.url.includes('rrf.example'))!;
    expect(m2.explain?.multipliers?.recency).toBeGreaterThan(1.05);
    expect(o2.explain?.multipliers?.recency ?? 1).toBeLessThan(1.02);
    await wv2.close();

    // Corroboration boost (opt-in) multiplies corroborated passages; date-asc ordering renumbers.
    const wv3 = make({
      retrieval: {
        nearDuplicateThreshold: 1,
        mmr: false,
        relativeCutoff: 0,
        corroborationBoost: true,
      },
      output: { order: 'date-asc' },
    });
    const r3 = await wv3.research('reciprocal rank fusion constant k', { topK: 4, explain: true });
    expect(
      r3.passages.find((p) => p.url.includes('rrf.example'))?.explain?.multipliers?.corroboration,
    ).toBeCloseTo(1.1, 5);
    const dates = r3.passages.map((p) => p.publishedAt ?? '');
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
    expect(r3.passages.map((p) => p.index)).toEqual(r3.passages.map((_, i) => i + 1));
    await wv3.close();
  });
  it('rejects empty query and reports abort', async () => {
    const wv = make();
    await expect(wv.research('   ')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await wv.close();
  });
  it('mergeSearchResults dedupes across query lists', () => {
    const m = mergeSearchResults([
      [
        { url: 'https://a/x', title: 'a', rank: 1, source: 's' },
        { url: 'https://b/y', title: 'b', rank: 2, source: 's' },
      ],
      [
        { url: 'https://www.a/x?utm_source=1', title: 'a', rank: 1, source: 's' },
        { url: 'https://c/z', title: 'c', rank: 2, source: 's' },
      ],
    ]);
    expect(m.map((r) => r.url)).toEqual(['https://a/x', 'https://b/y', 'https://c/z']);
    expect(m[0]!.rank).toBe(1);
  });
});

describe('tool schemas + bindings', () => {
  it('json schema definitions are valid and strict mode works', () => {
    const d = webResearchToolDefinition();
    expect(d.name).toBe('web_research');
    expect((d.inputSchema as any).properties.query.type).toBe('string');
    expect((d.inputSchema as any).required).toEqual(['query']);
    const strict = webResearchToolDefinition({ strict: true }).inputSchema as any;
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required.sort()).toEqual(Object.keys(strict.properties).sort());
    expect(strict.properties.top_k.type).toEqual(['integer', 'null']);
    expect(webFetchToolDefinition().name).toBe('web_fetch');
    expect(webSearchToolDefinition().name).toBe('web_search');
    expect(webResearchInputSchema.safeParse({ query: 'x' }).success).toBe(false); // min 2
    expect(webResearchInputSchema.safeParse({ query: 'ok', top_k: 500 }).success).toBe(false);
  });
  it('anthropic + openai tool arrays and runners', async () => {
    mockSites();
    const wv = make();
    expect(anthropicTools().map((t) => t.name)).toEqual([
      'web_research',
      'web_fetch',
      'web_search',
    ]);
    expect(
      anthropicTools({ include: ['web_research'], cacheControl: true })[0]!.cache_control,
    ).toEqual({ type: 'ephemeral' });
    const oa = openaiTools();
    expect(oa[0]).toMatchObject({ type: 'function', name: 'web_research', strict: true });
    const r = await runOpenAITool(
      wv,
      'web_research',
      JSON.stringify({
        query: 'rank fusion',
        top_k: 2,
        related_queries: null,
        max_pages: null,
        freshness: null,
        domains_allow: null,
        domains_block: null,
        session_id: null,
      }),
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('[1]');
    const s = await runAnthropicTool(wv, 'web_search', { query: 'x', count: 2 });
    expect(s.content).toContain('1. RRF intro');
    const bad = await runAnthropicTool(wv, 'web_fetch', { url: 'https://down.example/x' });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/FETCH_HTTP_ERROR/);
    const unknown = await runAnthropicTool(wv, 'nope', {});
    expect(unknown.isError).toBe(true);
    await wv.close();
  });
  it('renderMarkdown respects token budget', () => {
    const res: any = {
      query: 'q',
      queries: ['q'],
      passages: Array.from({ length: 20 }, (_, i) => ({
        index: i + 1,
        text: 'x '.repeat(400),
        url: 'https://u',
        title: 't',
        score: 1,
        chunkIndex: 0,
        startOffset: 0,
        endOffset: 1,
        fetchedAt: '',
        matchedQueries: [],
        citation: '',
      })),
      sources: [],
      failures: [],
      stats: {
        search: { provider: 'p', attempts: [], resultCount: 0, ms: 0 },
        ingest: { requested: 0, fetched: 0, ok: 0, failed: 0, cached: 0, bytes: 0, ms: 0 },
        embed: { provider: '', model: '', dimensions: 0, chunks: 0, cached: 0, batches: 0, ms: 0 },
        retrieve: { candidates: 0, queries: 1, reranked: false, ms: 0 },
        totalMs: 0,
        warnings: [],
      },
    };
    const md = renderMarkdown(res, { maxTokens: 500 });
    expect(md.length).toBeLessThan(500 * 4 + 1500);
    expect((md.match(/\*\*\[\d+\]\*\*/g) ?? []).length).toBeLessThan(20);
    expect(md).toMatch(
      /_\d+ more passages omitted \(indices [\d, ]+\)\. Ask again with a larger budget or fetch \[\d+\] for detail\._/,
    );
  });
  it('packPassages keeps the top passage and one per source before filling by score/token', async () => {
    const { packPassages } = await import('../src/pipeline/format.js');
    const mk = (index: number, url: string, score: number, len: number): any => ({
      index,
      url,
      score,
      text: 'x'.repeat(len),
      title: 't',
    });
    const passages = [
      mk(1, 'https://a', 1, 4000), // top-1: big
      mk(2, 'https://a', 0.9, 400),
      mk(3, 'https://b', 0.5, 400), // best of source b
      mk(4, 'https://a', 0.8, 400),
      mk(5, 'https://c', 0.2, 400), // best of source c
    ];
    const rendered = passages.map((p) => p.text as string);
    // 1000 tokens of budget = 4000 chars: top-1 alone fills it → nothing else fits.
    let packed = packPassages(passages, rendered, 1001);
    expect(packed.included.map((p) => p.index)).toEqual([1]);
    expect(packed.omitted).toEqual([2, 3, 4, 5]);
    // 1300 tokens: top-1 + best-of-b + best-of-c (guarantees) before the higher-scored [2]/[4].
    packed = packPassages(passages, rendered, 1303);
    expect(packed.included.map((p) => p.index)).toEqual([1, 3, 5]);
    // Enough budget: everything, in original order.
    packed = packPassages(passages, rendered, 10_000);
    expect(packed.included.map((p) => p.index)).toEqual([1, 2, 3, 4, 5]);
    expect(packed.omitted).toEqual([]);
  });
});

describe('pipeline hardening', () => {
  it('tool/opts limits can lower but never exceed the operator config', async () => {
    mockSites();
    const wv = make({
      ingestion: {
        maxPages: 2,
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        allowPrivateNetworks: true,
        minChunkChars: 20,
      },
      retrieval: { topK: 2, relativeCutoff: 0, mmr: false },
    });
    const res = await wv.research('rank fusion banana python', { maxPages: 50, topK: 50 });
    expect(res.stats.ingest.requested).toBe(2);
    expect(res.passages.length).toBeLessThanOrEqual(2);
    await wv.close();
  });
  it('the run deadline aborts in-flight fetches (no orphaned work after return)', async () => {
    mockSites();
    let aborted = false;
    server.use(
      http.get('https://slow.example/x', async ({ request }) => {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
          setTimeout(resolve, 5000);
        });
        return HttpResponse.html(page('Slow', ['slow slow']));
      }),
    );
    const slowSearch = customSearchProvider('slow', async () => [
      { url: 'https://slow.example/x', title: 'Slow', rank: 1 },
    ]);
    const wv = make({
      search: { instance: slowSearch, fallbackProviders: [] },
      ingestion: {
        totalDeadlineMs: 1000,
        timeoutMs: 10_000,
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        allowPrivateNetworks: true,
        minChunkChars: 20,
      },
    });
    const t0 = Date.now();
    const res = await wv.research('rank fusion');
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(res.failures.some((f) => f.code === 'FETCH_TIMEOUT')).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted).toBe(true);
    await wv.close();
  });
});
