import { envKeyFor } from '../config/env.js';
import { importOptional, requireApiKey, WebVectorError } from '../errors.js';
import type { LlmFn, Logger, Reranker, ScoredChunk } from '../types.js';
import { requestJson } from '../util/http.js';

export interface RerankerOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  logger?: Logger;
  /** Max chars of each document sent to the reranker. */
  maxDocChars?: number;
  /** Local: dtype / cacheDir. */
  dtype?: string;
  cacheDir?: string;
}

const needKey = (provider: string, key: string | undefined, envs: string[]) =>
  requireApiKey(
    `${provider} reranker`,
    key,
    envs,
    'retrieval.rerankApiKey',
    'Or use `retrieval.rerank: local` (npm i @huggingface/transformers).',
  );

function docsOf(chunks: ScoredChunk[], max = 3000): string[] {
  return chunks.map((c) => (c.text.length > max ? c.text.slice(0, max) : c.text));
}

function applyScores(
  chunks: ScoredChunk[],
  scores: { index: number; score: number }[],
  topN?: number,
): ScoredChunk[] {
  const out = scores
    .filter((s) => s.index >= 0 && s.index < chunks.length)
    .map((s) => ({ ...(chunks[s.index] as ScoredChunk), rerankScore: s.score }))
    .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
  return topN ? out.slice(0, topN) : out;
}

/** Cohere Rerank (`rerank-v4.0-fast` default; v3.5 also fine). */
export class CohereReranker implements Reranker {
  readonly id = 'cohere';
  private readonly key: string;
  private readonly model: string;
  constructor(private readonly opts: RerankerOptions = {}) {
    this.key = needKey(
      'Cohere',
      opts.apiKey ?? process.env.COHERE_API_KEY ?? process.env.CO_API_KEY,
      ['COHERE_API_KEY'],
    );
    this.model = opts.model ?? 'rerank-v4.0-fast';
  }
  async rerank(
    query: string,
    chunks: ScoredChunk[],
    o: { topN?: number; signal?: AbortSignal } = {},
  ): Promise<ScoredChunk[]> {
    if (chunks.length === 0) return [];
    const json = await requestJson<any>(
      `${(this.opts.baseUrl ?? 'https://api.cohere.com/v2').replace(/\/$/, '')}/rerank`,
      {
        provider: 'cohere-rerank',
        headers: { authorization: `Bearer ${this.key}` },
        body: {
          model: this.model,
          query,
          documents: docsOf(chunks, this.opts.maxDocChars),
          top_n: o.topN ?? chunks.length,
        },
        timeoutMs: this.opts.timeoutMs ?? 30_000,
        signal: o.signal,
      },
    );
    return applyScores(
      chunks,
      (json?.results ?? []).map((r: any) => ({ index: r.index, score: r.relevance_score })),
      o.topN,
    );
  }
}

/** Voyage Rerank (`rerank-2.5-lite` default). */
export class VoyageReranker implements Reranker {
  readonly id = 'voyage';
  private readonly key: string;
  private readonly model: string;
  constructor(private readonly opts: RerankerOptions = {}) {
    this.key = needKey('Voyage', opts.apiKey ?? process.env.VOYAGE_API_KEY, ['VOYAGE_API_KEY']);
    this.model = opts.model ?? 'rerank-2.5-lite';
  }
  async rerank(
    query: string,
    chunks: ScoredChunk[],
    o: { topN?: number; signal?: AbortSignal } = {},
  ): Promise<ScoredChunk[]> {
    if (chunks.length === 0) return [];
    const json = await requestJson<any>(
      `${(this.opts.baseUrl ?? 'https://api.voyageai.com/v1').replace(/\/$/, '')}/rerank`,
      {
        provider: 'voyage-rerank',
        headers: { authorization: `Bearer ${this.key}` },
        body: {
          model: this.model,
          query,
          documents: docsOf(chunks, this.opts.maxDocChars),
          top_k: o.topN ?? chunks.length,
          truncation: true,
        },
        timeoutMs: this.opts.timeoutMs ?? 30_000,
        signal: o.signal,
      },
    );
    return applyScores(
      chunks,
      (json?.data ?? []).map((r: any) => ({ index: r.index, score: r.relevance_score })),
      o.topN,
    );
  }
}

/** Jina Reranker (`jina-reranker-v3` default). */
export class JinaReranker implements Reranker {
  readonly id = 'jina';
  private readonly key: string;
  private readonly model: string;
  constructor(private readonly opts: RerankerOptions = {}) {
    this.key = needKey('Jina', opts.apiKey ?? process.env.JINA_API_KEY, ['JINA_API_KEY']);
    this.model = opts.model ?? 'jina-reranker-v3';
  }
  async rerank(
    query: string,
    chunks: ScoredChunk[],
    o: { topN?: number; signal?: AbortSignal } = {},
  ): Promise<ScoredChunk[]> {
    if (chunks.length === 0) return [];
    const json = await requestJson<any>(
      `${(this.opts.baseUrl ?? 'https://api.jina.ai/v1').replace(/\/$/, '')}/rerank`,
      {
        provider: 'jina-rerank',
        headers: { authorization: `Bearer ${this.key}` },
        body: {
          model: this.model,
          query,
          documents: docsOf(chunks, this.opts.maxDocChars),
          top_n: o.topN ?? chunks.length,
          return_documents: false,
        },
        timeoutMs: this.opts.timeoutMs ?? 30_000,
        signal: o.signal,
      },
    );
    return applyScores(
      chunks,
      (json?.results ?? []).map((r: any) => ({ index: r.index, score: r.relevance_score })),
      o.topN,
    );
  }
}

/** Local cross-encoder via Transformers.js (`Xenova/ms-marco-MiniLM-L-6-v2` default). */
export class LocalReranker implements Reranker {
  readonly id = 'local';
  private readonly model: string;
  private loaded?: Promise<{ tok: any; model: any }>;
  constructor(private readonly opts: RerankerOptions = {}) {
    this.model = opts.model ?? 'Xenova/ms-marco-MiniLM-L-6-v2';
  }
  private load(): Promise<{ tok: any; model: any }> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const tf: any = await importOptional(
          '@huggingface/transformers',
          'the local reranker (retrieval.rerank: local)',
          'local-rerank',
        );
        if (this.opts.cacheDir) tf.env.cacheDir = this.opts.cacheDir;
        const [tok, model] = await Promise.all([
          tf.AutoTokenizer.from_pretrained(this.model),
          tf.AutoModelForSequenceClassification.from_pretrained(this.model, {
            dtype: this.opts.dtype ?? 'q8',
          }),
        ]);
        return { tok, model };
      })();
      this.loaded.catch(() => {
        this.loaded = undefined;
      });
    }
    return this.loaded;
  }
  async rerank(
    query: string,
    chunks: ScoredChunk[],
    o: { topN?: number; signal?: AbortSignal } = {},
  ): Promise<ScoredChunk[]> {
    if (chunks.length === 0) return [];
    const { tok, model } = await this.load();
    const docs = docsOf(chunks, this.opts.maxDocChars ?? 2000);
    const scores: { index: number; score: number }[] = [];
    const batch = 16;
    for (let i = 0; i < docs.length; i += batch) {
      if (o.signal?.aborted) throw new WebVectorError('Rerank aborted', { code: 'ABORTED' });
      const slice = docs.slice(i, i + batch);
      const inputs = tok(new Array(slice.length).fill(query), {
        text_pair: slice,
        padding: true,
        truncation: true,
      });
      const { logits } = await model(inputs);
      const list: number[][] = logits.sigmoid().tolist();
      list.forEach((row, j) => scores.push({ index: i + j, score: row[0] ?? 0 }));
    }
    return applyScores(chunks, scores, o.topN);
  }
}

/** Listwise LLM reranker using a provider-agnostic `LlmFn` (returns a ranked list of indices). */
export class LlmReranker implements Reranker {
  readonly id = 'llm';
  constructor(
    private readonly llm: LlmFn,
    private readonly opts: { maxDocChars?: number; maxDocs?: number } = {},
  ) {}
  async rerank(
    query: string,
    chunks: ScoredChunk[],
    o: { topN?: number; signal?: AbortSignal } = {},
  ): Promise<ScoredChunk[]> {
    if (chunks.length === 0) return [];
    const cands = chunks.slice(0, this.opts.maxDocs ?? 30);
    const docs = docsOf(cands, this.opts.maxDocChars ?? 700);
    const prompt = `Rank the passages by how well they answer the query. Query: "${query}"

${docs.map((d, i) => `[${i}] ${d.replace(/\s+/g, ' ')}`).join('\n\n')}

Return ONLY a JSON array of passage indices ordered from most to least relevant, e.g. [3,0,7]. Include every index exactly once.`;
    let order: number[] | null = null;
    try {
      const text = await this.llm(prompt, { signal: o.signal });
      const m = /\[[\d,\s]*\]/.exec(text);
      if (m) order = JSON.parse(m[0]);
    } catch {
      order = null;
    }
    if (!order || !Array.isArray(order)) return chunks.slice(0, o.topN);
    const seen = new Set<number>();
    const ranked: number[] = [];
    for (const i of order)
      if (Number.isInteger(i) && i >= 0 && i < cands.length && !seen.has(i)) {
        seen.add(i);
        ranked.push(i);
      }
    for (let i = 0; i < cands.length; i++) if (!seen.has(i)) ranked.push(i);
    const n = ranked.length;
    return applyScores(
      cands,
      ranked.map((idx, pos) => ({ index: idx, score: (n - pos) / n })),
      o.topN,
    );
  }
}

/** Wrap a scoring function as a Reranker. */
export function customReranker(
  id: string,
  fn: (query: string, texts: string[], signal?: AbortSignal) => Promise<number[]>,
): Reranker {
  return {
    id,
    async rerank(query, chunks, o = {}) {
      const scores = await fn(
        query,
        chunks.map((c) => c.text),
        o.signal,
      );
      return applyScores(
        chunks,
        scores.map((score, index) => ({ index, score })),
        o.topN,
      );
    },
  };
}

type Factory = (opts: RerankerOptions) => Reranker;
const registry = new Map<string, Factory>([
  ['cohere', (o) => new CohereReranker(o)],
  ['voyage', (o) => new VoyageReranker(o)],
  ['jina', (o) => new JinaReranker(o)],
  ['local', (o) => new LocalReranker(o)],
  ['transformers', (o) => new LocalReranker(o)],
]);
export function registerReranker(name: string, factory: Factory): void {
  registry.set(name, factory);
}
export function listRerankers(): string[] {
  return [...registry.keys(), 'llm'];
}
export function createReranker(name: string, opts: RerankerOptions = {}): Reranker {
  const f = registry.get(name);
  if (!f)
    throw new WebVectorError(`Unknown reranker "${name}".`, {
      code: 'UNKNOWN_PROVIDER',
      remediation: `Use one of: ${listRerankers().join(', ')} (llm requires retrieval.llm), or registerReranker().`,
    });
  return f({ ...opts, apiKey: opts.apiKey ?? envKeyFor(name) });
}
