import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customEmbeddingProvider } from '../src/embeddings/base.js';
import { WebVector } from '../src/pipeline/webvector.js';
import { customSearchProvider } from '../src/search/providers.js';
import { OtelTracer } from '../src/telemetry/otel.js';
import { silentLogger } from '../src/util/logger.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();
beforeAll(() => {
  // A host application does this (NodeSDK / NodeTracerProvider); WebVector itself never does.
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

const KEYS = ['fusion', 'rank', 'banana'];
const toy = customEmbeddingProvider(
  'toy',
  'toy-1',
  async (texts) =>
    texts.map((t) => KEYS.map((k) => (t.toLowerCase().split(k).length - 1) * 1.0 + 0.01)),
  { dimensions: 3 },
);
const page = (title: string, para: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${para} ${'Additional filler sentence to make the paragraph long enough for extraction. '.repeat(6)}</p></article></body></html>`;
const SITES: Record<string, string> = {
  'https://rrf.example/intro': page('RRF intro', 'Reciprocal rank fusion combines ranked lists.'),
  'https://fruit.example/banana': page('Bananas', 'Banana banana banana is a fruit.'),
};
const fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
  return new Response(SITES[url] ?? 'nf', {
    status: SITES[url] ? 200 : 404,
    headers: { 'content-type': 'text/html' },
  });
};
const search = customSearchProvider('mock', async () =>
  Object.keys(SITES).map((url, i) => ({ url, title: url, rank: i + 1 })),
);
const make = (telemetry: { otel: boolean; captureContent?: boolean }) =>
  new WebVector(
    {
      search: { instance: search, fallbackProviders: [] },
      embeddings: { instance: toy },
      ingestion: {
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        allowPrivateNetworks: true,
        minChunkChars: 20,
        chunkSize: 80,
        cache: { dir: false },
      },
      retrieval: { relativeCutoff: 0, mmr: false, queryExpansion: false },
      telemetry,
      logger: silentLogger,
      fetch: fetchImpl,
    },
    { env: {} },
  );

describe('OpenTelemetry spans (opt-in, @opentelemetry/api only)', () => {
  it('emits execute_tool → search / fetch / embeddings / retrieval spans with GenAI attributes', async () => {
    exporter.reset();
    const wv = make({ otel: true, captureContent: true });
    const res = await wv.research('rank fusion', { topK: 3 });
    expect(res.passages.length).toBeGreaterThan(0);
    await wv.close();
    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toContain('execute_tool webvector_research');
    expect(names).toContain('search mock');
    expect(names).toContain('fetch rrf.example');
    expect(names).toContain('fetch fruit.example');
    expect(names).toContain('embeddings toy-1');
    expect(names).toContain('retrieval');
    const root = spans.find((s) => s.name === 'execute_tool webvector_research')!;
    expect(root.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(root.attributes['gen_ai.tool.name']).toBe('webvector_research');
    expect(root.attributes['webvector.query']).toBe('rank fusion'); // captureContent
    expect(root.attributes['webvector.passages']).toBe(res.passages.length);
    // every other span belongs to the same trace and has a parent (search/fetch/retrieval → root;
    // query embeddings → retrieval): context propagates through the usage meter and stages
    const ids = new Set(spans.map((s) => s.spanContext().spanId));
    for (const s of spans.filter((x) => x !== root)) {
      expect(s.spanContext().traceId).toBe(root.spanContext().traceId);
      expect(ids.has(s.parentSpanContext?.spanId ?? '')).toBe(true);
    }
    expect(spans.find((s) => s.name === 'search mock')?.parentSpanContext?.spanId).toBe(
      root.spanContext().spanId,
    );
    expect(spans.find((s) => s.name === 'retrieval')?.parentSpanContext?.spanId).toBe(
      root.spanContext().spanId,
    );
    const emb = spans.find((s) => s.name === 'embeddings toy-1')!;
    expect(emb.attributes['gen_ai.operation.name']).toBe('embeddings');
    expect(emb.attributes['gen_ai.provider.name']).toBe('toy');
    expect(emb.attributes['gen_ai.request.model']).toBe('toy-1');
    expect(Number(emb.attributes['gen_ai.usage.input_tokens'])).toBeGreaterThan(0);
    const f = spans.find((s) => s.name === 'fetch rrf.example')!;
    expect(f.attributes['url.full']).toBe('https://rrf.example/intro');
    expect(f.attributes['webvector.fetch.cache']).toBe('miss');
  });

  it('keeps content out of spans by default and emits nothing when telemetry.otel is off', async () => {
    exporter.reset();
    const wv = make({ otel: true });
    await wv.research('rank fusion');
    await wv.close();
    const root = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'execute_tool webvector_research')!;
    expect(root.attributes['webvector.query']).toBeUndefined();
    const f = exporter.getFinishedSpans().find((s) => s.name.startsWith('fetch '))!;
    expect(f.attributes['url.full']).toBeUndefined();
    expect(f.attributes['server.address']).toBeTruthy();

    exporter.reset();
    const off = make({ otel: false });
    await off.research('rank fusion');
    await off.close();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('OtelTracer.disabled() / missing API is a pass-through', async () => {
    const t = OtelTracer.disabled();
    expect(t.enabled).toBe(false);
    const out = await t.span('x', { a: 1 }, async (span) => {
      span.set({ b: 2 });
      return 42;
    });
    expect(out).toBe(42);
  });
});
