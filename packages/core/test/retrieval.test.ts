import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { customEmbeddingProvider, EmbeddingCache } from '../src/embeddings/base.js';
import {
  CohereEmbeddings,
  GeminiEmbeddings,
  OllamaEmbeddings,
  OpenAIEmbeddings,
  VoyageEmbeddings,
} from '../src/embeddings/hosted.js';
import { WebVectorError } from '../src/errors.js';
import {
  CohereReranker,
  customReranker,
  LlmReranker,
  LocalReranker,
} from '../src/rerankers/index.js';
import { BM25Index, tokenize } from '../src/retrieval/bm25.js';
import { HeuristicExpander, LlmExpander } from '../src/retrieval/expansion.js';
import {
  dbsfNormalize,
  dedupeChunks,
  diversifyBySource,
  minMaxNormalize,
  mmr,
  rrf,
  scoreFusion,
  shingleJaccard,
} from '../src/retrieval/fusion.js';
import { MemoryVectorStore } from '../src/stores/memory.js';
import { embeddingProviderConformance, vectorStoreConformance } from '../src/testing/index.js';
import type { Chunk, ScoredChunk } from '../src/types.js';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const vec = (...xs: number[]) => {
  const v = new Float32Array(xs);
  let n = 0;
  for (const x of xs) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
const chunk = (
  id: string,
  text: string,
  url = `https://s.com/${id}`,
  v?: Float32Array,
): ScoredChunk => ({
  id,
  text,
  vector: v,
  score: 0,
  metadata: {
    url,
    canonicalUrl: url,
    title: id,
    chunkIndex: 0,
    totalChunks: 1,
    startOffset: 0,
    endOffset: text.length,
    contentHash: id,
    pageHash: 'p',
    fetchedAt: 't',
    searchRank: 1,
    searchQuery: 'q',
    contentType: 'text/plain',
    provider: 'x',
  },
});

describe('BM25', () => {
  it('tokenizes with stopwords + light stemming', () => {
    expect(tokenize('The Rankings of fused lists!')).toEqual(['ranking', 'fused', 'list']);
    expect(tokenize('Combining ranked results')).toEqual(['combin', 'rank', 'result']);
  });
  it('ranks relevant docs higher and supports remove/filter', () => {
    const idx = new BM25Index();
    idx.add('a', 'reciprocal rank fusion merges ranked lists using ranks');
    idx.add('b', 'bananas are yellow fruit');
    idx.add('c', 'rank fusion is a fusion of ranks');
    const r = idx.search('rank fusion', 10);
    expect(r[0]!.id).toBe('c');
    expect(r.map((x) => x.id)).not.toContain('b');
    expect(idx.search('rank fusion', 10, (id) => id !== 'c')[0]!.id).toBe('a');
    idx.remove('c');
    expect(idx.search('rank fusion', 10)[0]!.id).toBe('a');
    expect(
      BM25Index.topTerms(
        ['rank fusion explained', 'reciprocal rank fusion formula'],
        3,
        new Set(['rank']),
      ),
    ).toContain('fusion');
  });
});

describe('fusion + diversity', () => {
  it('rrf merges with weights', () => {
    const f = rrf(
      [
        [
          { id: 'a', score: 1 },
          { id: 'b', score: 0.5 },
        ],
        [
          { id: 'b', score: 9 },
          { id: 'c', score: 8 },
        ],
      ],
      { k: 60, weights: [1, 1] },
    );
    expect(f[0]!.id).toBe('b');
    expect(f.map((x) => x.id)).toEqual(['b', 'a', 'c']);
    const w = rrf([[{ id: 'a', score: 1 }], [{ id: 'b', score: 1 }]], { weights: [0, 1] });
    expect(w[0]!.id).toBe('b');
    expect(w).toHaveLength(1);
  });
  it('score normalisers', () => {
    expect(
      minMaxNormalize([
        { id: 'a', score: 2 },
        { id: 'b', score: 4 },
      ]).map((x) => x.score),
    ).toEqual([0, 1]);
    expect(
      dbsfNormalize([
        { id: 'a', score: 1 },
        { id: 'b', score: 1 },
      ])[0]!.score,
    ).toBeCloseTo(0.5, 1);
    expect(
      scoreFusion(
        [
          [
            { id: 'a', score: 1 },
            { id: 'b', score: 0 },
          ],
          [{ id: 'b', score: 1 }],
        ],
        [0.75, 0.25],
      )[0]!.id,
    ).toBe('a');
  });
  it('mmr prefers diverse results', () => {
    const q = vec(1, 0, 0);
    const c = [
      chunk('a', 'a', 'u1', vec(0.95, 0.31, 0)),
      chunk('a2', 'a2', 'u2', vec(0.95, 0.31, 0)),
      chunk('b', 'b', 'u3', vec(0.8, 0, 0.6)),
    ];
    c.forEach((x) => (x.score = 1));
    const out = mmr(q, c, 2, 0.5);
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
    expect(mmr(q, c, 2, 1).map((x) => x.id)).toEqual(['a', 'a2']);
  });
  it('diversifyBySource caps and round-robins', () => {
    const hits = [
      chunk('1', 'x', 'https://a'),
      chunk('2', 'x', 'https://a'),
      chunk('3', 'x', 'https://a'),
      chunk('4', 'x', 'https://b'),
      chunk('5', 'x', 'https://c'),
    ];
    hits.forEach((h, i) => (h.score = 1 - i * 0.1));
    expect(diversifyBySource(hits, 2, 10).map((h) => h.id)).toEqual(['1', '4', '5', '2']);
  });
  it('dedupeChunks removes exact and near duplicates', () => {
    const t = 'the quick brown fox jumps over the lazy dog and keeps running far away';
    const c = [
      chunk('a', t),
      chunk('b', t),
      chunk('c', `${t} today`),
      chunk('d', 'completely different text about bananas and apples in the market'),
    ];
    c[1]!.metadata.contentHash = 'a';
    c[2]!.metadata.contentHash = 'c';
    expect(dedupeChunks(c, 0.8).map((x) => x.id)).toEqual(['a', 'd']);
    expect(shingleJaccard('a b c d e f', 'a b c d e f')).toBe(1);
  });
});

describe('MemoryVectorStore', () => {
  for (const c of vectorStoreConformance(() => new MemoryVectorStore(), { dims: 8 }))
    it(`conformance: ${c.name}`, c.run);
  it('returns top-k sorted with filters', async () => {
    const s = new MemoryVectorStore();
    await s.init(3, 'm');
    const cs: Chunk[] = [
      {
        ...chunk('a', 'a', 'https://a', vec(1, 0, 0)),
        metadata: { ...chunk('a', 'a').metadata, sessionId: 's1' },
      },
      {
        ...chunk('b', 'b', 'https://b', vec(0, 1, 0)),
        metadata: { ...chunk('b', 'b').metadata, sessionId: 's2' },
      },
      {
        ...chunk('c', 'c', 'https://c', vec(0.9, 0.1, 0)),
        metadata: { ...chunk('c', 'c').metadata, sessionId: 's1' },
      },
    ];
    await s.upsert(cs);
    const r = await s.query(vec(1, 0, 0), { topK: 2 });
    expect(r.map((x) => x.id)).toEqual(['a', 'c']);
    expect(r[0]!.score).toBeCloseTo(1);
    const r2 = await s.query(vec(1, 0, 0), { topK: 5, sessionId: 's2' });
    expect(r2.map((x) => x.id)).toEqual(['b']);
    expect(s.size()).toBe(3);
    expect(s.all('s1')).toHaveLength(2);
  });
});

describe('embedding providers (mocked HTTP)', () => {
  it('OpenAI batches, decodes base64, preserves order and normalises', async () => {
    let calls = 0;
    server.use(
      http.post('https://api.openai.com/v1/embeddings', async ({ request }) => {
        calls++;
        const body: any = await request.json();
        expect(body.encoding_format).toBe('base64');
        const data = (body.input as string[]).map((t, i) => {
          const buf = Buffer.alloc(8);
          buf.writeFloatLE(t.length, 0);
          buf.writeFloatLE(1, 4);
          return { index: i, embedding: buf.toString('base64') };
        });
        return HttpResponse.json({ data: data.reverse(), usage: { total_tokens: 1 } });
      }),
    );
    const p = new OpenAIEmbeddings({ apiKey: 'sk-test', batchSize: 2 });
    const out = await p.embed(['a', 'bbb', 'cc']);
    expect(calls).toBe(2);
    expect(out[1]![0]).toBeCloseTo(3 / Math.sqrt(10));
    expect(await p.dimensions()).toBe(1536);
  });
  it('OpenAI missing key → MISSING_API_KEY with remediation', () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new OpenAIEmbeddings({})).toThrow(WebVectorError);
      try {
        new OpenAIEmbeddings({});
      } catch (e) {
        expect((e as WebVectorError).code).toBe('MISSING_API_KEY');
        expect((e as WebVectorError).remediation).toContain('OPENAI_API_KEY');
      }
    } finally {
      if (prev) process.env.OPENAI_API_KEY = prev;
    }
  });
  it('Gemini v2 uses prompt-in-text task and batch endpoint', async () => {
    let body: any;
    server.use(
      http.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents',
        async ({ request }) => {
          body = await request.json();
          expect(request.headers.get('x-goog-api-key')).toBe('AIzatest');
          return HttpResponse.json({ embeddings: body.requests.map(() => ({ values: [3, 4] })) });
        },
      ),
    );
    const p = new GeminiEmbeddings({ apiKey: 'AIzatest', dimensions: 2 });
    const [q] = await p.embed(['hello'], { kind: 'query' });
    expect(body.requests[0].content.parts[0].text).toBe('task: search result | query: hello');
    expect(body.requests[0].config.outputDimensionality).toBe(2);
    expect(q![0]).toBeCloseTo(0.6);
  });
  it('Gemini 001 uses taskType', async () => {
    let body: any;
    server.use(
      http.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ embeddings: [{ values: [1, 0] }] });
        },
      ),
    );
    await new GeminiEmbeddings({ apiKey: 'k', model: 'gemini-embedding-001' }).embed(['x'], {
      kind: 'document',
    });
    expect(body.requests[0].config.taskType).toBe('RETRIEVAL_DOCUMENT');
    expect(body.requests[0].content.parts[0].text).toBe('x');
  });
  it('Voyage/Cohere send input types', async () => {
    let vb: any;
    let cb: any;
    server.use(
      http.post('https://api.voyageai.com/v1/embeddings', async ({ request }) => {
        vb = await request.json();
        return HttpResponse.json({ data: [{ index: 0, embedding: [1, 1] }] });
      }),
      http.post('https://api.cohere.com/v2/embed', async ({ request }) => {
        cb = await request.json();
        return HttpResponse.json({ embeddings: { float: [[1, 1]] } });
      }),
    );
    await new VoyageEmbeddings({ apiKey: 'k' }).embed(['x'], { kind: 'query' });
    await new CohereEmbeddings({ apiKey: 'k' }).embed(['x'], { kind: 'document' });
    expect(vb.input_type).toBe('query');
    expect(cb.input_type).toBe('search_document');
    expect(cb.embedding_types).toEqual(['float']);
  });
  it('Ollama adds nomic prefixes and helpful connection error', async () => {
    let body: any;
    server.use(
      http.post('http://127.0.0.1:11434/api/embed', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ embeddings: [[1, 0]] });
      }),
    );
    await new OllamaEmbeddings({ model: 'nomic-embed-text' }).embed(['q'], { kind: 'query' });
    expect(body.input[0]).toBe('search_query: q');
    server.use(http.post('http://127.0.0.1:11434/api/embed', () => HttpResponse.error()));
    await expect(new OllamaEmbeddings({}).embed(['q'])).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });
  it('rate limit retries with backoff then succeeds', async () => {
    let n = 0;
    server.use(
      http.post('https://api.voyageai.com/v1/embeddings', () => {
        n++;
        return n < 3
          ? new HttpResponse('slow', { status: 429, headers: { 'retry-after': '0' } })
          : HttpResponse.json({ data: [{ index: 0, embedding: [1, 0] }] });
      }),
    );
    const out = await new VoyageEmbeddings({ apiKey: 'k' }).embed(['x']);
    expect(out).toHaveLength(1);
    expect(n).toBe(3);
  });
  it('custom provider passes conformance', async () => {
    const p = customEmbeddingProvider(
      'fake',
      'fake-1',
      async (texts) =>
        texts.map((t) => [
          t.includes('fusion') || t.includes('rank') ? 1 : 0,
          t.includes('banana') ? 1 : 0,
          0.1,
        ]),
      { dimensions: 3 },
    );
    for (const c of embeddingProviderConformance(() => p)) await c.run();
  });
  it('EmbeddingCache hits/misses', () => {
    const c = new EmbeddingCache(10);
    expect(c.get('m', 'h', 'document')).toBeUndefined();
    c.set('m', 'h', 'document', new Float32Array([1]));
    expect(c.get('m', 'h', 'document')).toBeDefined();
    expect(c.hits).toBe(1);
    expect(c.misses).toBe(1);
  });
});

describe('expansion', () => {
  it('heuristic expander produces keyword + PRF variants without duplicates', async () => {
    const out = await new HeuristicExpander().expand('what is reciprocal rank fusion', {
      searchResults: [
        {
          url: 'https://a',
          title: 'Reciprocal Rank Fusion (RRF) explained',
          snippet: 'RRF combines ranked lists using reciprocal ranks with constant k',
          rank: 1,
          source: 'x',
        },
        {
          url: 'https://b',
          title: 'Hybrid search scoring',
          snippet: 'Azure AI Search uses RRF for hybrid queries',
          rank: 2,
          source: 'x',
        },
      ],
      related: [],
      max: 4,
    });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(new Set(out.map((s) => s.toLowerCase())).size).toBe(out.length);
    expect(out.some((s) => s.startsWith('reciprocal rank fusion'))).toBe(true);
  });
  it('llm expander parses lines and falls back', async () => {
    const e = new LlmExpander(
      async () => '1. RRF formula k=60\n- how rrf merges lists\n"rank fusion vs score fusion"',
    );
    const out = await e.expand('rrf', { searchResults: [], related: [], max: 2 });
    expect(out).toEqual(['RRF formula k=60', 'how rrf merges lists']);
    const bad = new LlmExpander(async () => {
      throw new Error('down');
    });
    expect(
      await bad.expand('reciprocal rank fusion', { searchResults: [], related: [], max: 2 }),
    ).toBeInstanceOf(Array);
  });
});

describe('rerankers', () => {
  const chunks = [
    chunk('a', 'bananas'),
    chunk('b', 'reciprocal rank fusion formula'),
    chunk('c', 'weather'),
  ];
  it('cohere reranker maps results', async () => {
    server.use(
      http.post('https://api.cohere.com/v2/rerank', () =>
        HttpResponse.json({
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.1 },
          ],
        }),
      ),
    );
    const r = await new CohereReranker({ apiKey: 'k' }).rerank('rrf', chunks, { topN: 2 });
    expect(r.map((x) => x.id)).toEqual(['b', 'a']);
    expect(r[0]!.rerankScore).toBe(0.9);
  });
  it('llm reranker parses index arrays and completes missing', async () => {
    const r = await new LlmReranker(async () => 'Sure: [1, 2]').rerank('rrf', chunks);
    expect(r.map((x) => x.id)).toEqual(['b', 'c', 'a']);
    const bad = await new LlmReranker(async () => 'no json').rerank('rrf', chunks, { topN: 2 });
    expect(bad).toHaveLength(2);
  });
  it('custom reranker', async () => {
    const r = await customReranker('x', async (_q, texts) =>
      texts.map((t) => (t.includes('fusion') ? 1 : 0)),
    ).rerank('q', chunks, { topN: 1 });
    expect(r[0]!.id).toBe('b');
  });
  it('local reranker requires transformers (present in dev) — smoke', async () => {
    const r = new LocalReranker();
    expect(r.id).toBe('local');
  });
});

describe('BM25 fields, variants, tokenizer', () => {
  it('keeps compound identifiers as whole tokens plus their parts', async () => {
    const { tokenize } = await import('../src/retrieval/bm25.js');
    const t = tokenize(
      'Use AbortSignal.any with text-embedding-3-small on 2025-11-25 in snake_case',
    );
    expect(t).toContain('abortsignal.any');
    expect(t).toContain('text-embedding-3-small');
    expect(t).toContain('2025-11-25');
    expect(t).toContain('snake_case');
    expect(t).toContain('abortsignal'); // parts still present
    expect(t).not.toContain('1.5'); // short decimals are dropped as compounds
  });

  it('BM25F: a title match outranks a body-only match when title is weighted', async () => {
    const { BM25Index } = await import('../src/retrieval/bm25.js');
    const mk = (w: number) => {
      const ix = new BM25Index({ fieldWeights: { title: w, body: 1 } });
      ix.add('a', {
        title: 'Streamable HTTP transport',
        body: 'The transport sends frames over a connection and buffers them.',
      });
      ix.add('b', {
        title: 'Overview',
        body: 'Streamable HTTP is discussed briefly. The transport is fast.',
      });
      return ix.search('streamable http');
    };
    expect(mk(1)[0]!.id).toBe('b'); // body has both terms; equal weights → body wins
    expect(mk(3)[0]!.id).toBe('a'); // weighted title wins
  });

  it('proximity bonus prefers adjacent query terms; quoted phrases must match exactly', async () => {
    const { BM25Index } = await import('../src/retrieval/bm25.js');
    const ix = new BM25Index({ proximityWeight: 1 });
    ix.add('near', 'the reciprocal rank fusion algorithm merges lists');
    ix.add(
      'far',
      'reciprocal values appear here while rank and fusion are mentioned much later in the text',
    );
    const hits = ix.search('reciprocal rank fusion');
    expect(hits[0]!.id).toBe('near');
    const phrase = ix.search('"rank fusion"');
    expect(phrase.map((h) => h.id)).toEqual(['near']);
  });

  it('bmx variant and coverage bonus rank a doc covering all terms above a repetitive one', async () => {
    const { BM25Index } = await import('../src/retrieval/bm25.js');
    for (const opts of [{ variant: 'bmx' as const }, { coverageWeight: 1 }]) {
      const ix = new BM25Index(opts);
      ix.add('cover', 'alpha beta gamma appear together once each in this passage of text');
      ix.add(
        'repeat',
        'alpha alpha alpha alpha alpha alpha alpha alpha is repeated in this passage of text',
      );
      ix.add('noise', 'unrelated words about weather and bananas fill this passage of text');
      const hits = ix.search('alpha beta gamma');
      expect(hits[0]!.id).toBe('cover');
    }
  });

  it('remove() keeps postings consistent', async () => {
    const { BM25Index } = await import('../src/retrieval/bm25.js');
    const ix = new BM25Index();
    ix.add('a', 'kiwi fruit');
    ix.add('b', 'kiwi bird');
    ix.remove('a');
    expect(ix.search('kiwi').map((h) => h.id)).toEqual(['b']);
    expect(ix.search('fruit')).toEqual([]);
  });
});

describe('autocut and lexical MMR', () => {
  it('autocut cuts after a large score jump but keeps minKeep', async () => {
    const { autocut } = await import('../src/retrieval/fusion.js');
    expect(autocut([1, 0.98, 0.97, 0.5, 0.49, 0.48], 1)).toBe(3);
    expect(autocut([1, 0.5, 0.49, 0.48], 1, { minKeep: 3 })).toBe(4); // jump before minKeep is ignored
    expect(autocut([1, 0.9, 0.8, 0.7], 1)).toBe(4); // no jump
    expect(autocut([1, 0.98, 0.97, 0.5, 0.49, 0.1], 2, { factor: 2 })).toBe(5);
    expect(autocut([1, 0.98, 0.97, 0.5, 0.49, 0.1], 2)).toBe(6); // 3× mean gap: no jump qualifies
  });
  it('mmr without vectors demotes near-paraphrases using text similarity', async () => {
    const { mmr } = await import('../src/retrieval/fusion.js');
    const cands = [
      {
        id: 'a',
        score: 1,
        text: 'reciprocal rank fusion combines ranked lists using 1 over k plus rank',
      },
      {
        id: 'b',
        score: 0.95,
        text: 'reciprocal rank fusion combines ranked lists using 1 over k plus rank today',
      },
      {
        id: 'c',
        score: 0.9,
        text: 'bananas grow in warm climates and are a popular fruit worldwide',
      },
    ];
    const out = mmr(undefined, cands, 2, 0.5, { relevance: [1, 0.95, 0.9] });
    expect(out.map((c) => c.id)).toEqual(['a', 'c']);
  });
});

describe('lexicalAffinity', () => {
  it('boosts exact-match queries and lowers long natural-language questions', async () => {
    const { lexicalAffinity } = await import('../src/pipeline/retrieve-stage.js');
    expect(lexicalAffinity('AbortSignal.any example')).toBeGreaterThan(1);
    expect(lexicalAffinity('"reciprocal rank fusion" k 60')).toBeGreaterThan(1.5);
    expect(
      lexicalAffinity('why do people prefer typed languages for large projects today'),
    ).toBeLessThan(1);
    expect(lexicalAffinity('banana bread recipe')).toBe(1);
  });
});

describe('registrableDomain', () => {
  it('collapses subdomains and handles ccSLDs', async () => {
    const { registrableDomain } = await import('../src/pipeline/retrieve-stage.js');
    expect(registrableDomain('https://docs.python.org/3/')).toBe('python.org');
    expect(registrableDomain('https://en.m.wikipedia.org/wiki/X')).toBe('wikipedia.org');
    expect(registrableDomain('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(registrableDomain('https://example.com')).toBe('example.com');
  });
});

describe('adjacent-chunk merge', () => {
  it('groupAdjacent groups consecutive chunks of one page, preserving score order', async () => {
    const { groupAdjacent } = await import('../src/retrieval/fusion.js');
    const mk = (id: string, url: string, ci: number) => {
      const c = chunk(id, `text ${id}`, url);
      c.metadata.chunkIndex = ci;
      return c;
    };
    const items = [
      mk('a4', 'https://a', 4),
      mk('b1', 'https://b', 1),
      mk('a3', 'https://a', 3),
      mk('a9', 'https://a', 9),
      mk('b2', 'https://b', 2),
    ];
    const groups = groupAdjacent(items).map((g) => g.map((x) => x.id));
    expect(groups).toEqual([['a3', 'a4'], ['b1', 'b2'], ['a9']]);
  });
  it('joinAdjacentText removes chunker overlap via offsets, by scan, or joins with a break', async () => {
    const { joinAdjacentText } = await import('../src/retrieval/fusion.js');
    const page = 'The quick brown fox jumps over the lazy dog. Then it ran away into the forest.';
    const meta = (start: number, end: number, ci: number) => ({
      canonicalUrl: 'https://p',
      chunkIndex: ci,
      startOffset: start,
      endOffset: end,
    });
    const a = { text: page.slice(0, 44), metadata: meta(0, 44, 0) };
    const b = { text: page.slice(20), metadata: meta(20, page.length, 1) }; // overlaps a by 24 chars
    expect(joinAdjacentText(a, b)).toBe(page);
    // Offsets slightly off (chunker gap): the suffix/prefix scan still finds the overlap.
    const bOff = { ...b, metadata: meta(22, page.length + 2, 1) };
    expect(joinAdjacentText(a, bOff)).toBe(page);
    // No textual overlap at all: paragraph break.
    const c = { text: 'Unrelated continuation text here.', metadata: meta(60, 90, 1) };
    expect(joinAdjacentText(a, c)).toBe(`${a.text}\n\nUnrelated continuation text here.`);
  });
});

describe('highlights', () => {
  it('segmentText splits sentences but keeps code fences, tables and list lines whole', async () => {
    const { segmentText } = await import('../src/retrieval/highlight.js');
    const text = [
      'Intro sentence one. Second sentence, e.g. with an abbreviation. Third one!',
      '```js',
      'const x = 1. Not a sentence break.',
      '```',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '- a list item. With a period.',
    ].join('\n');
    const segs = segmentText(text);
    expect(segs.map((s) => s.kind)).toEqual([
      'sentence',
      'sentence',
      'sentence',
      'block',
      'block',
      'line',
    ]);
    expect(segs[1]!.text).toBe('Second sentence, e.g. with an abbreviation.');
    expect(segs[3]!.text.startsWith('```js')).toBe(true);
    expect(segs[3]!.text.endsWith('```')).toBe(true);
    // Offsets are exact slices of the input.
    for (const s of segs) expect(text.slice(s.start, s.end)).toBe(s.text);
  });
  it('bestHighlight picks the sentence window covering the query terms with page offsets', async () => {
    const { bestHighlight, rankHighlightWindows } = await import('../src/retrieval/highlight.js');
    const text =
      '# Fusion\nBananas are yellow. Reciprocal rank fusion combines ranked lists using a constant k. It needs no tuning. Weather is nice today.';
    const terms = new Map([
      ['reciprocal', 2],
      ['rank', 1],
      ['fusion', 1],
      ['constant', 1.5],
    ]);
    const hl = bestHighlight(text, 1000, { terms });
    expect(hl?.text).toBe('Reciprocal rank fusion combines ranked lists using a constant k.');
    expect(text.slice(hl!.startOffset - 1000, hl!.endOffset - 1000)).toBe(hl!.text);
    // Heading-only windows are penalised even when they match every term.
    const wins = rankHighlightWindows(
      '# Reciprocal rank fusion constant\nSome prose about reciprocal rank fusion and its constant.',
      { terms, top: 1 },
    );
    expect(wins[0]!.text).toMatch(/^Some prose/);
    // No matching term: lead window instead of the shortest fragment.
    const lead = bestHighlight('Alpha beta gamma delta. Second sentence here.', 0, {
      terms: new Map([['zzz', 1]]),
    });
    expect(lead?.text).toBe('Alpha beta gamma delta. Second sentence here.');
    // A code fence never gets cut in the middle.
    const code = 'Text before.\n```\nline one rank fusion\nline two\n```\nAfter.';
    const h2 = bestHighlight(code, 0, { terms });
    expect(h2?.text).toBe('```\nline one rank fusion\nline two\n```');
  });
});

describe('xQuAD aspect coverage', () => {
  it('covers every aspect before any aspect gets a third passage', async () => {
    const { xquad } = await import('../src/retrieval/fusion.js');
    // 6 candidates: a1..a3 relevant to aspect A (and slightly more relevant overall), b1..b3 to B.
    const ids = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'];
    const relevance = [1, 0.95, 0.9, 0.85, 0.8, 0.75];
    const A = { weight: 1, rel: [1, 0.9, 0.8, 0, 0, 0] };
    const B = { weight: 1, rel: [0, 0, 0, 1, 0.9, 0.8] };
    const { items, scores } = xquad(ids, relevance, [A, B], 4, 0.5);
    expect(items[0]).toBe('a1');
    expect(items[1]).toBe('b1'); // aspect B gets covered before A gets its 2nd
    // Both aspects are fully covered by their top hits (rel = 1) → the rest is relevance order.
    expect(items.slice(2)).toEqual(['a2', 'a3']);
    // With partial coverage and λ = 1 the selection alternates between aspects.
    const A2 = { weight: 1, rel: [0.6, 0.5, 0.4, 0, 0, 0] };
    const B2 = { weight: 1, rel: [0, 0, 0, 0.6, 0.5, 0.4] };
    expect(xquad(ids, relevance, [A2, B2], 4, 1).items).toEqual(['a1', 'b1', 'a2', 'b2']);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]!);
    // λ = 0 → pure relevance order.
    expect(xquad(ids, relevance, [A, B], 3, 0).items).toEqual(['a1', 'a2', 'a3']);
  });
});
