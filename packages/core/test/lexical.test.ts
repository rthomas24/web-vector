import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { autoEmbeddingProviderName, createEmbeddingProvider } from '../src/embeddings/index.js';
import { WebVector } from '../src/pipeline/webvector.js';
import { customSearchProvider } from '../src/search/providers.js';
import { silentLogger } from '../src/util/logger.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const page = (title: string, paras: string[]) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${paras.map((p) => `<p>${p} ${'Filler sentence to make the paragraph long enough for extraction. '.repeat(6)}</p>`).join('')}</article></body></html>`;

const search = customSearchProvider('mock', async () => [
  { url: 'https://rrf.example/intro', title: 'RRF intro', snippet: 'rank fusion', rank: 1 },
  { url: 'https://fruit.example/banana', title: 'Bananas', snippet: 'fruit', rank: 2 },
]);

function mock() {
  server.use(
    http.get('https://rrf.example/intro', () =>
      HttpResponse.html(
        page('RRF intro', [
          'Reciprocal rank fusion sums 1/(k+rank) over lists.',
          'The constant k is usually 60 and dampens top ranks.',
        ]),
      ),
    ),
    http.get('https://fruit.example/banana', () =>
      HttpResponse.html(page('Bananas', ['Bananas are yellow fruit that grow in bunches.'])),
    ),
    http.get('*/robots.txt', () => new HttpResponse('', { status: 404 })),
  );
}

describe("lexical-only mode (embeddings.provider: 'none')", () => {
  it('runs the full pipeline with BM25 only — no embeddings, not degraded', async () => {
    mock();
    const wv = new WebVector(
      {
        search: { instance: search, fallbackProviders: [] },
        embeddings: { provider: 'none' },
        ingestion: {
          respectRobotsTxt: false,
          perHostMinIntervalMs: 0,
          retries: 0,
          allowPrivateNetworks: true,
          minChunkChars: 20,
          chunkSize: 80,
        },
        retrieval: { maxPerSource: 3 },
        logger: silentLogger,
      },
      { env: {} },
    );
    const res = await wv.research('what does the k constant do in rank fusion', { topK: 3 });
    expect(res.passages.length).toBeGreaterThan(0);
    expect(res.passages[0]!.url).toBe('https://rrf.example/intro');
    expect(res.passages[0]!.text).toMatch(/k/);
    expect(res.passages[0]!.cosine).toBeUndefined();
    expect(res.passages[0]!.bm25).toBeGreaterThan(0);
    expect(res.stats.embed).toMatchObject({
      provider: 'none',
      model: 'bm25',
      dimensions: 0,
      chunks: 0,
    });
    expect(res.degraded).toBeUndefined();
    expect(res.stats.ingest.ok).toBe(2);
    // fetchAndRetrieve also works without an embedder
    const one = await wv.fetchAndRetrieve('https://rrf.example/intro', 'constant k 60', {
      topK: 1,
    });
    expect(one.passages).toHaveLength(1);
    expect(one.stats.embed.provider).toBe('none');
    await wv.close();
  });
  it("'lexical' is an alias and session mode works without vectors", async () => {
    mock();
    const wv = new WebVector(
      {
        search: { instance: search, fallbackProviders: [] },
        embeddings: { provider: 'lexical' },
        store: { mode: 'session' },
        ingestion: {
          respectRobotsTxt: false,
          perHostMinIntervalMs: 0,
          retries: 0,
          allowPrivateNetworks: true,
          minChunkChars: 20,
          cache: { enabled: false },
        },
        logger: silentLogger,
      },
      { env: {} },
    );
    const a = await wv.research('rank fusion', { sessionId: 's1' });
    const b = await wv.research('yellow fruit bunches', { sessionId: 's1' });
    expect(a.passages.length).toBeGreaterThan(0);
    expect(b.stats.ingest.cached).toBe(2);
    expect(b.passages[0]!.url).toBe('https://fruit.example/banana');
    await wv.close();
  });
  it('external store config is ignored (with a warning) in lexical mode', async () => {
    mock();
    const warnings: string[] = [];
    const wv = new WebVector(
      {
        search: { instance: search, fallbackProviders: [] },
        embeddings: { provider: 'none' },
        store: { provider: 'qdrant', url: 'http://127.0.0.1:1' },
        ingestion: {
          respectRobotsTxt: false,
          perHostMinIntervalMs: 0,
          retries: 0,
          allowPrivateNetworks: true,
          minChunkChars: 20,
        },
        logger: { ...silentLogger, warn: (m) => void warnings.push(m) },
      },
      { env: {} },
    );
    const res = await wv.research('rank fusion');
    expect(res.passages.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('lexical-only'))).toBe(true);
    await wv.close();
  });
});

describe('embeddings provider resolution', () => {
  it("'auto' resolves to a concrete provider or 'none'", async () => {
    const r = await autoEmbeddingProviderName();
    expect(['local', 'openai', 'voyage', 'gemini', 'cohere', 'mistral', 'jina', 'none']).toContain(
      r.name,
    );
    expect(r.reason).toBeTruthy();
  });
  it('pseudo-providers are rejected by the factory with guidance', () => {
    for (const n of ['auto', 'none', 'lexical']) {
      expect(() => createEmbeddingProvider(n)).toThrow(/resolves it internally|lexical mode/);
    }
  });
});
