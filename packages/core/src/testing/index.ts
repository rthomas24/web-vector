/**
 * Conformance helpers for adapter authors. Framework-agnostic: each function returns a list of
 * named async checks that throw on failure — wire them into vitest/jest/node:test with a loop:
 *
 * ```ts
 * for (const c of searchProviderConformance(() => new MyProvider())) test(c.name, c.run);
 * ```
 */
import type { Chunk, EmbeddingProvider, SearchProvider, VectorStore } from '../types.js';
import { sha256 } from '../util/hash.js';

export interface ConformanceCheck {
  name: string;
  run: () => Promise<void>;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Conformance failure: ${msg}`);
}

export function searchProviderConformance(
  factory: () => SearchProvider,
  opts: { query?: string; live?: boolean } = {},
): ConformanceCheck[] {
  const query = opts.query ?? 'reciprocal rank fusion';
  const checks: ConformanceCheck[] = [
    {
      name: 'exposes id and capabilities',
      run: async () => {
        const p = factory();
        assert(typeof p.id === 'string' && p.id.length > 0, 'id must be a non-empty string');
        const caps = p.capabilities();
        assert(
          typeof caps.maxResults === 'number' && caps.maxResults > 0,
          'capabilities.maxResults > 0',
        );
        assert(typeof caps.requiresApiKey === 'boolean', 'capabilities.requiresApiKey boolean');
      },
    },
  ];
  if (opts.live) {
    checks.push({
      name: 'returns normalised results',
      run: async () => {
        const p = factory();
        const results = await p.search(query, { count: 5 });
        assert(Array.isArray(results), 'search() returns an array');
        assert(results.length > 0, 'search() returns at least one result');
        for (const r of results) {
          assert(/^https?:\/\//.test(r.url), `url must be absolute http(s): ${r.url}`);
          assert(!r.url.includes('#'), 'url must not contain a fragment');
          assert(typeof r.title === 'string', 'title must be a string');
          assert(Number.isInteger(r.rank) && r.rank >= 1, 'rank must be a 1-based integer');
          assert(r.source === p.id, 'source must equal provider id');
        }
        const urls = new Set(results.map((r) => r.url));
        assert(urls.size === results.length, 'results must be deduplicated by URL');
      },
    });
  }
  return checks;
}

export function embeddingProviderConformance(factory: () => EmbeddingProvider): ConformanceCheck[] {
  return [
    {
      name: 'reports dimensions and limits',
      run: async () => {
        const p = factory();
        await p.init?.();
        const dims = await p.dimensions();
        assert(Number.isInteger(dims) && dims > 0, 'dimensions() must be a positive integer');
        const lim = p.limits();
        assert(lim.maxBatchSize > 0, 'limits().maxBatchSize > 0');
      },
    },
    {
      name: 'embeds documents and queries as normalised Float32Arrays of the right size',
      run: async () => {
        const p = factory();
        await p.init?.();
        const dims = await p.dimensions();
        const texts = [
          'The quick brown fox jumps over the lazy dog.',
          'Reciprocal rank fusion merges ranked lists.',
          'Bananas are yellow.',
        ];
        const docs = await p.embed(texts, { kind: 'document' });
        assert(docs.length === texts.length, 'one vector per input');
        for (const v of docs) {
          assert(v instanceof Float32Array, 'vectors must be Float32Array');
          assert(v.length === dims, `vector length ${v.length} must equal dimensions ${dims}`);
          let n = 0;
          for (let i = 0; i < v.length; i++) n += (v[i] as number) ** 2;
          assert(Math.abs(Math.sqrt(n) - 1) < 1e-3, 'vectors must be L2-normalised');
        }
        const [q] = await p.embed(['how does rank fusion combine lists?'], { kind: 'query' });
        assert(q && q.length === dims, 'query vector has same dimensions');
        const sim = (a: Float32Array, b: Float32Array) => {
          let s = 0;
          for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
          return s;
        };
        assert(
          sim(q!, docs[1]!) > sim(q!, docs[2]!),
          'semantically related text must score higher than unrelated text',
        );
      },
    },
    {
      name: 'preserves order across batches',
      run: async () => {
        const p = factory();
        const texts = Array.from(
          { length: Math.min(70, p.limits().maxBatchSize * 2 + 3) },
          (_, i) => `document number ${i} about topic ${i % 7}`,
        );
        const a = await p.embed(texts);
        const b = await p.embed([texts[texts.length - 1] as string]);
        let s = 0;
        for (let i = 0; i < b[0]!.length; i++)
          s += (a[texts.length - 1]![i] as number) * (b[0]![i] as number);
        assert(s > 0.98, 'last vector of a batched call must equal the same text embedded alone');
      },
    },
  ];
}

export function vectorStoreConformance(
  factory: () => VectorStore | Promise<VectorStore>,
  opts: { dims?: number } = {},
): ConformanceCheck[] {
  const dims = opts.dims ?? 8;
  const mk = (id: string, seed: number, sessionId?: string): Chunk => {
    const v = new Float32Array(dims);
    for (let i = 0; i < dims; i++) v[i] = Math.sin(seed * (i + 1));
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n);
    for (let i = 0; i < dims; i++) v[i] = (v[i] as number) / n;
    return {
      id,
      text: `chunk ${id}`,
      vector: v,
      metadata: {
        url: `https://example.com/${id}`,
        canonicalUrl: `https://example.com/${id}`,
        title: id,
        chunkIndex: 0,
        totalChunks: 1,
        startOffset: 0,
        endOffset: 5,
        contentHash: sha256(id),
        pageHash: sha256(id),
        fetchedAt: new Date().toISOString(),
        searchRank: 1,
        searchQuery: 'q',
        contentType: 'text/plain',
        provider: 'test',
        sessionId,
      },
    };
  };
  return [
    {
      name: 'upsert, query, has, clear round-trip',
      run: async () => {
        const s = await factory();
        await s.init?.(dims, 'test-model');
        await s.clear();
        await s.init?.(dims, 'test-model');
        const chunks = [mk('a', 1, 's1'), mk('b', 2, 's1'), mk('c', 3, 's2')];
        await s.upsert(chunks);
        await s.upsert([chunks[0] as Chunk]); // idempotent
        if (s.has) {
          const h = await s.has(['a', 'zzz']);
          assert(h.has('a') && !h.has('zzz'), 'has() must report existing ids only');
        }
        const res = await s.query(chunks[1]!.vector as Float32Array, { topK: 3 });
        assert(res.length >= 1 && res[0]!.id === 'b', 'nearest neighbour of b must be b');
        assert(res[0]!.score > 0.99, 'self-similarity must be ~1');
        if (s.capabilities().supportsFilter) {
          const scoped = await s.query(chunks[2]!.vector as Float32Array, {
            topK: 3,
            sessionId: 's1',
          });
          assert(
            scoped.every((r) => r.metadata.sessionId === 's1'),
            'sessionId filter must be honoured',
          );
        }
        await s.clear('s1');
        const after = await s.query(chunks[0]!.vector as Float32Array, { topK: 3 });
        assert(
          !after.some((r) => r.id === 'a' || r.id === 'b'),
          'clear(sessionId) must remove only that session',
        );
        await s.clear();
        await s.close?.();
      },
    },
    {
      name: 'rejects mismatched dimensions',
      run: async () => {
        const s = await factory();
        await s.init?.(dims, 'test-model');
        let threw = false;
        try {
          await s.upsert([{ ...mk('x', 5), vector: new Float32Array(dims + 1) }]);
        } catch {
          threw = true;
        }
        assert(threw, 'upsert with wrong dimensions must throw');
        await s.clear();
        await s.close?.();
      },
    },
  ];
}
