/**
 * Live tests — hit the real network and load the local model. Run with `npm run test:live`.
 * Provider-specific tests only run when the corresponding key/URL is present.
 */
import { describe, expect, it } from 'vitest';
import { createEmbeddingProvider } from '../src/embeddings/index.js';
import { WebVector } from '../src/pipeline/webvector.js';
import { createSearchProvider } from '../src/search/index.js';
import { createVectorStore } from '../src/stores/index.js';
import {
  embeddingProviderConformance,
  searchProviderConformance,
  vectorStoreConformance,
} from '../src/testing/index.js';
import { silentLogger } from '../src/util/logger.js';

const live = process.env.WEBVECTOR_LIVE === '1';
const d = live ? describe : describe.skip;

d('zero-config end-to-end (DuckDuckGo + local MiniLM + memory)', () => {
  it('returns cited passages for a factual query in < 20s', async () => {
    const wv = new WebVector({ logger: silentLogger });
    const t0 = Date.now();
    const res = await wv.research('what is reciprocal rank fusion', { topK: 5, maxPages: 6 });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(20_000);
    expect(res.passages.length).toBeGreaterThan(0);
    expect(res.passages[0]!.text.toLowerCase()).toMatch(/rank|fusion|rrf/);
    expect(res.stats.ingest.ok).toBeGreaterThan(0);
    expect(res.stats.embed.dimensions).toBe(384);
    expect(res.markdown).toContain('## Sources');
    for (const p of res.passages) {
      expect(p.url).toMatch(/^https?:\/\//);
      expect(p.citation).toContain(p.url);
    }
    // session reuse
    const res2 = await wv.research('how does RRF weight rankings', { sessionId: 's', maxPages: 4 });
    const res3 = await wv.research('RRF k constant 60', { sessionId: 's', maxPages: 4 });
    expect(res3.stats.ingest.cached).toBeGreaterThan(0);
    expect(res2.passages.length + res3.passages.length).toBeGreaterThan(0);
    await wv.close();
  }, 120_000);
  it('fetches and parses HTML, markdown-served docs, and PDF', async () => {
    const wv = new WebVector({ logger: silentLogger });
    const html = await wv.fetch('https://en.wikipedia.org/wiki/Learning_to_rank');
    expect(html.parser).toBe('readability');
    expect(html.markdown.length).toBeGreaterThan(5000);
    const pdf = await wv.fetch('https://arxiv.org/pdf/1706.03762');
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.title).toMatch(/Attention Is All You Need/i);
    const rr = await wv.fetchAndRetrieve(
      'https://arxiv.org/pdf/1706.03762',
      'multi-head attention formula',
      { topK: 3 },
    );
    expect(rr.passages.length).toBe(3);
    await wv.close();
  }, 120_000);
});

d('search providers (keyless)', () => {
  for (const name of ['duckduckgo', 'wikipedia', 'tavily-keyless']) {
    for (const c of searchProviderConformance(() => createSearchProvider(name), { live: true }))
      it(`${name}: ${c.name}`, c.run, 60_000);
  }
});

d('search providers (keyed, when configured)', () => {
  const keyed: [string, string][] = [
    ['brave', 'BRAVE_API_KEY'],
    ['serper', 'SERPER_API_KEY'],
    ['serpapi', 'SERPAPI_API_KEY'],
    ['tavily', 'TAVILY_API_KEY'],
    ['exa', 'EXA_API_KEY'],
    ['perplexity', 'PERPLEXITY_API_KEY'],
    ['searxng', 'SEARXNG_URL'],
  ];
  for (const [name, env] of keyed) {
    const has = !!process.env[env];
    for (const c of searchProviderConformance(() => createSearchProvider(name), { live: true }))
      (has ? it : it.skip)(`${name}: ${c.name}`, c.run, 60_000);
  }
});

d('embedding providers', () => {
  for (const c of embeddingProviderConformance(() => createEmbeddingProvider('local')))
    it(`local: ${c.name}`, c.run, 300_000);
  const keyed: [string, string][] = [
    ['openai', 'OPENAI_API_KEY'],
    ['gemini', 'GEMINI_API_KEY'],
    ['voyage', 'VOYAGE_API_KEY'],
    ['cohere', 'COHERE_API_KEY'],
    ['mistral', 'MISTRAL_API_KEY'],
    ['jina', 'JINA_API_KEY'],
    ['ollama', 'OLLAMA_HOST'],
  ];
  for (const [name, env] of keyed) {
    const has = !!process.env[env];
    for (const c of embeddingProviderConformance(() => createEmbeddingProvider(name)))
      (has ? it : it.skip)(`${name}: ${c.name}`, c.run, 120_000);
  }
});

d('vector stores (when configured)', () => {
  const stores: [string, string][] = [
    ['chroma', 'CHROMA_URL'],
    ['qdrant', 'QDRANT_URL'],
    ['pgvector', 'DATABASE_URL'],
  ];
  for (const [name, env] of stores) {
    const has = !!process.env[env];
    for (const c of vectorStoreConformance(
      () => createVectorStore(name, { collection: `webvector_test_${Date.now().toString(36)}` }),
      { dims: 8 },
    ))
      (has ? it : it.skip)(`${name}: ${c.name}`, c.run, 120_000);
  }
});
