import { requireApiKey, WebVectorError } from '../errors.js';
import type { EmbeddingLimits, EmbedKind } from '../types.js';
import { requestJson } from '../util/http.js';
import { decodeBase64Float32, toFloat32 } from '../util/vector.js';
import { type BaseEmbeddingOptions, HttpEmbeddingProvider } from './base.js';

const OFFLINE_HINT =
  'For offline use: `embeddings.provider: local` (npm i @huggingface/transformers) or `embeddings.provider: none` (lexical BM25).';
const needKey = (provider: string, key: string | undefined, envs: string[]) =>
  requireApiKey(`${provider} embeddings`, key, envs, 'embeddings.apiKey', OFFLINE_HINT);

// ─── OpenAI (+ compatible) ──────────────────────────────────────────────────

const OPENAI_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

/**
 * OpenAI embeddings and any OpenAI-compatible `/v1/embeddings` endpoint (LM Studio, Ollama /v1,
 * OpenRouter, Together, DeepInfra, vLLM, TEI, Azure with baseUrl).
 */
export class OpenAIEmbeddings extends HttpEmbeddingProvider {
  readonly id: string;
  readonly model: string;
  private readonly key?: string;
  private readonly url: string;
  private dims?: number;
  constructor(opts: BaseEmbeddingOptions & { compatible?: boolean; requireKey?: boolean } = {}) {
    super(opts);
    const compatible = opts.compatible ?? false;
    this.id = compatible ? 'openai-compatible' : 'openai';
    this.model = opts.model ?? 'text-embedding-3-small';
    const key =
      opts.apiKey ??
      (compatible ? process.env.OPENAI_COMPATIBLE_API_KEY : undefined) ??
      process.env.OPENAI_API_KEY;
    this.key =
      compatible && !(opts.requireKey ?? false) ? key : needKey('OpenAI', key, ['OPENAI_API_KEY']);
    const base = (
      opts.baseUrl ??
      (compatible ? process.env.OPENAI_COMPATIBLE_BASE_URL : undefined) ??
      'https://api.openai.com/v1'
    ).replace(/\/$/, '');
    this.url = base.endsWith('/embeddings') ? base : `${base}/embeddings`;
    this.dims = opts.dimensions ?? (compatible ? undefined : OPENAI_DIMS[this.model]);
  }
  limits(): EmbeddingLimits {
    return {
      maxBatchSize: this.id === 'openai' ? 2048 : 256,
      maxTokensPerInput: 8191,
      maxTokensPerBatch: this.id === 'openai' ? 280_000 : undefined,
      maxInputChars: 24_000,
    };
  }
  async dimensions(): Promise<number> {
    if (this.dims) return this.dims;
    const [v] = await this.embed(['dimension probe']);
    this.dims = v!.length;
    return this.dims;
  }
  protected async embedBatch(
    texts: string[],
    _kind: EmbedKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
      ...(this.base.options ?? {}),
    };
    if (this.base.dimensions && /text-embedding-3/.test(this.model))
      body.dimensions = this.base.dimensions;
    if (this.id === 'openai') body.encoding_format = 'base64';
    const json = await requestJson<any>(this.url, {
      provider: this.id,
      headers: this.key ? { authorization: `Bearer ${this.key}` } : {},
      body,
      timeoutMs: this.timeoutMs,
      signal,
      retries: 0,
    });
    const data: any[] = json?.data ?? [];
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map((d) =>
      typeof d.embedding === 'string' ? decodeBase64Float32(d.embedding) : toFloat32(d.embedding),
    );
  }
}

// ─── Gemini ─────────────────────────────────────────────────────────────────

/** Google Gemini embeddings (`gemini-embedding-2` default; `gemini-embedding-001` supported). */
export class GeminiEmbeddings extends HttpEmbeddingProvider {
  readonly id = 'gemini';
  readonly model: string;
  private readonly key: string;
  private readonly url: string;
  private dims?: number;
  constructor(opts: BaseEmbeddingOptions = {}) {
    super(opts);
    this.model = opts.model ?? 'gemini-embedding-2';
    this.key = needKey(
      'Gemini',
      opts.apiKey ??
        process.env.GEMINI_API_KEY ??
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
        process.env.GOOGLE_API_KEY,
      ['GEMINI_API_KEY'],
    );
    const base = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      '',
    );
    this.url = `${base}/models/${this.model}:batchEmbedContents`;
    this.dims = opts.dimensions ?? 3072;
  }
  limits(): EmbeddingLimits {
    return {
      maxBatchSize: 100,
      maxTokensPerInput: this.model.includes('001') ? 2048 : 8192,
      maxInputChars: this.model.includes('001') ? 6000 : 24_000,
    };
  }
  dimensions(): number {
    return this.dims ?? 3072;
  }
  private isV2(): boolean {
    return !/embedding-001/.test(this.model);
  }
  protected async embedBatch(
    texts: string[],
    kind: EmbedKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    const v2 = this.isV2();
    const requests = texts.map((t) => {
      const text = v2
        ? kind === 'query'
          ? `task: search result | query: ${t}`
          : `title: none | text: ${t}`
        : t;
      const config: Record<string, unknown> = {};
      if (this.base.dimensions) config.outputDimensionality = this.base.dimensions;
      if (!v2) config.taskType = kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
      return {
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        ...(Object.keys(config).length ? { config } : {}),
      };
    });
    const json = await requestJson<any>(this.url, {
      provider: this.id,
      headers: { 'x-goog-api-key': this.key },
      body: { requests },
      timeoutMs: this.timeoutMs,
      signal,
      retries: 0,
    });
    const embs: any[] = json?.embeddings ?? [];
    // gemini-embedding-001 truncated outputs are not normalised — base class normalises everything.
    return embs.map((e) => toFloat32(e.values));
  }
}

// ─── Voyage ─────────────────────────────────────────────────────────────────

export class VoyageEmbeddings extends HttpEmbeddingProvider {
  readonly id = 'voyage';
  readonly model: string;
  private readonly key: string;
  private dims?: number;
  constructor(opts: BaseEmbeddingOptions = {}) {
    super(opts);
    this.model = opts.model ?? 'voyage-4-lite';
    this.key = needKey('Voyage AI', opts.apiKey ?? process.env.VOYAGE_API_KEY, ['VOYAGE_API_KEY']);
    this.dims =
      opts.dimensions ??
      (/voyage-3-large|voyage-4|voyage-3\.5|voyage-code/.test(this.model) ? 1024 : undefined);
  }
  limits(): EmbeddingLimits {
    const large = /large|code|context/.test(this.model);
    return {
      maxBatchSize: 128,
      maxTokensPerInput: 32_000,
      maxTokensPerBatch: large ? 100_000 : 250_000,
      maxInputChars: 60_000,
    };
  }
  async dimensions(): Promise<number> {
    if (this.dims) return this.dims;
    const [v] = await this.embed(['dimension probe']);
    this.dims = v!.length;
    return this.dims;
  }
  protected async embedBatch(
    texts: string[],
    kind: EmbedKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      input: texts,
      model: this.model,
      input_type: kind,
      truncation: true,
      ...(this.base.options ?? {}),
    };
    if (this.base.dimensions) body.output_dimension = this.base.dimensions;
    const json = await requestJson<any>(
      `${(this.base.baseUrl ?? 'https://api.voyageai.com/v1').replace(/\/$/, '')}/embeddings`,
      {
        provider: this.id,
        headers: { authorization: `Bearer ${this.key}` },
        body,
        timeoutMs: this.timeoutMs,
        signal,
        retries: 0,
      },
    );
    const data: any[] = json?.data ?? [];
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map((d) => toFloat32(d.embedding));
  }
}

// ─── Cohere ─────────────────────────────────────────────────────────────────

export class CohereEmbeddings extends HttpEmbeddingProvider {
  readonly id = 'cohere';
  readonly model: string;
  private readonly key: string;
  private dims?: number;
  constructor(opts: BaseEmbeddingOptions = {}) {
    super(opts);
    this.model = opts.model ?? 'embed-v4.0';
    this.key = needKey(
      'Cohere',
      opts.apiKey ?? process.env.COHERE_API_KEY ?? process.env.CO_API_KEY,
      ['COHERE_API_KEY'],
    );
    this.dims =
      opts.dimensions ??
      (this.model.startsWith('embed-v4') ? 1536 : /light/.test(this.model) ? 384 : 1024);
  }
  limits(): EmbeddingLimits {
    return {
      maxBatchSize: 96,
      maxTokensPerInput: this.model.startsWith('embed-v4') ? 128_000 : 512,
      maxInputChars: this.model.startsWith('embed-v4') ? 60_000 : 1800,
    };
  }
  dimensions(): number {
    return this.dims ?? 1024;
  }
  protected async embedBatch(
    texts: string[],
    kind: EmbedKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      model: this.model,
      texts,
      input_type: kind === 'query' ? 'search_query' : 'search_document',
      embedding_types: ['float'],
      truncate: 'END',
      ...(this.base.options ?? {}),
    };
    if (this.base.dimensions && this.model.startsWith('embed-v4'))
      body.output_dimension = this.base.dimensions;
    const json = await requestJson<any>(
      `${(this.base.baseUrl ?? 'https://api.cohere.com/v2').replace(/\/$/, '')}/embed`,
      {
        provider: this.id,
        headers: { authorization: `Bearer ${this.key}` },
        body,
        timeoutMs: this.timeoutMs,
        signal,
        retries: 0,
      },
    );
    const floats: number[][] = json?.embeddings?.float ?? [];
    return floats.map((v) => toFloat32(v));
  }
}

// ─── Mistral / Jina (OpenAI-shaped with extras) ─────────────────────────────

export class MistralEmbeddings extends HttpEmbeddingProvider {
  readonly id = 'mistral';
  readonly model: string;
  private readonly key: string;
  constructor(opts: BaseEmbeddingOptions = {}) {
    super(opts);
    this.model = opts.model ?? 'mistral-embed';
    this.key = needKey('Mistral', opts.apiKey ?? process.env.MISTRAL_API_KEY, ['MISTRAL_API_KEY']);
  }
  limits(): EmbeddingLimits {
    return { maxBatchSize: 32, maxTokensPerInput: 8192, maxInputChars: 24_000 };
  }
  dimensions(): number {
    return this.base.dimensions ?? (this.model.startsWith('codestral') ? 1536 : 1024);
  }
  protected async embedBatch(
    texts: string[],
    _kind: EmbedKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
      ...(this.base.options ?? {}),
    };
    if (this.base.dimensions) body.output_dimension = this.base.dimensions;
    const json = await requestJson<any>(
      `${(this.base.baseUrl ?? 'https://api.mistral.ai/v1').replace(/\/$/, '')}/embeddings`,
      {
        provider: this.id,
        headers: { authorization: `Bearer ${this.key}` },
        body,
        timeoutMs: this.timeoutMs,
        signal,
        retries: 0,
      },
    );
    const data: any[] = json?.data ?? [];
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map((d) => toFloat32(d.embedding));
  }
}

export class JinaEmbeddings extends HttpEmbeddingProvider {
  readonly id = 'jina';
  readonly model: string;
  private readonly key: string;
  constructor(opts: BaseEmbeddingOptions = {}) {
    super(opts);
    this.model = opts.model ?? 'jina-embeddings-v3';
    this.key = needKey('Jina', opts.apiKey ?? process.env.JINA_API_KEY, ['JINA_API_KEY']);
  }
  limits(): EmbeddingLimits {
    return { maxBatchSize: 128, maxTokensPerInput: 8192, maxInputChars: 24_000 };
  }
  dimensions(): number {
    return this.base.dimensions ?? 1024;
  }
  protected async embedBatch(
    texts: string[],
    kind: EmbedKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
      task: kind === 'query' ? 'retrieval.query' : 'retrieval.passage',
      normalized: true,
      ...(this.base.options ?? {}),
    };
    if (this.base.dimensions) body.dimensions = this.base.dimensions;
    const json = await requestJson<any>(
      `${(this.base.baseUrl ?? 'https://api.jina.ai/v1').replace(/\/$/, '')}/embeddings`,
      {
        provider: this.id,
        headers: { authorization: `Bearer ${this.key}` },
        body,
        timeoutMs: this.timeoutMs,
        signal,
        retries: 0,
      },
    );
    const data: any[] = json?.data ?? [];
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map((d) => toFloat32(d.embedding));
  }
}

// ─── Ollama ─────────────────────────────────────────────────────────────────

const OLLAMA_PREFIX: Record<string, { query: string; document: string }> = {
  'nomic-embed-text': { query: 'search_query: ', document: 'search_document: ' },
  'nomic-embed-text-v2-moe': { query: 'search_query: ', document: 'search_document: ' },
  'snowflake-arctic-embed': {
    query: 'Represent this sentence for searching relevant passages: ',
    document: '',
  },
  embeddinggemma: { query: 'task: search result | query: ', document: 'title: none | text: ' },
};

/** Ollama native `/api/embed`. */
export class OllamaEmbeddings extends HttpEmbeddingProvider {
  readonly id = 'ollama';
  readonly model: string;
  private readonly url: string;
  private dims?: number;
  constructor(opts: BaseEmbeddingOptions = {}) {
    super(opts);
    this.model = opts.model ?? 'nomic-embed-text';
    let base = (
      opts.baseUrl ??
      process.env.OLLAMA_HOST ??
      process.env.OLLAMA_BASE_URL ??
      'http://127.0.0.1:11434'
    ).replace(/\/$/, '');
    if (!/^https?:\/\//.test(base)) base = `http://${base}`;
    this.url = `${base}/api/embed`;
    this.dims = opts.dimensions;
  }
  limits(): EmbeddingLimits {
    return { maxBatchSize: this.base.batchSize ?? 32, maxInputChars: 16_000 };
  }
  async dimensions(): Promise<number> {
    if (this.dims) return this.dims;
    const [v] = await this.embed(['dimension probe']);
    this.dims = v!.length;
    return this.dims;
  }
  protected async embedBatch(
    texts: string[],
    kind: EmbedKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    const family = Object.keys(OLLAMA_PREFIX).find((k) => this.model.startsWith(k));
    const prefix = family ? OLLAMA_PREFIX[family]![kind] : '';
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts.map((t) => prefix + t),
      truncate: true,
      ...(this.base.options ?? {}),
    };
    if (this.base.dimensions) body.dimensions = this.base.dimensions;
    let json: any;
    try {
      json = await requestJson<any>(this.url, {
        provider: this.id,
        body,
        timeoutMs: this.timeoutMs,
        signal,
        retries: 0,
      });
    } catch (err) {
      if (
        WebVectorError.is(err) &&
        err.code === 'PROVIDER_ERROR' &&
        /fetch failed|ECONNREFUSED/i.test(
          err.message + (err.cause instanceof Error ? err.cause.message : ''),
        )
      ) {
        throw new WebVectorError(`Cannot reach Ollama at ${this.url}.`, {
          code: 'PROVIDER_ERROR',
          provider: this.id,
          remediation: `Start Ollama (\`ollama serve\`), pull the model (\`ollama pull ${this.model}\`), or set OLLAMA_HOST / embeddings.baseUrl.`,
          cause: err,
        });
      }
      if (WebVectorError.is(err) && (err.details as any)?.status === 404) {
        throw new WebVectorError(`Ollama model "${this.model}" not found.`, {
          code: 'PROVIDER_ERROR',
          provider: this.id,
          remediation: `Run \`ollama pull ${this.model}\`.`,
          cause: err,
        });
      }
      throw err;
    }
    const embs: number[][] = json?.embeddings ?? [];
    return embs.map((v) => toFloat32(v));
  }
}
