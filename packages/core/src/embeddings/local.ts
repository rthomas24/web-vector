import { homedir } from 'node:os';
import { join } from 'node:path';
import { importOptional, WebVectorError } from '../errors.js';
import type {
  EmbeddingLimits,
  EmbeddingProvider,
  EmbedKind,
  EmbedOptions,
  Logger,
} from '../types.js';
import { l2Normalize, toFloat32 } from '../util/vector.js';

export interface LocalModelPreset {
  pooling: 'mean' | 'cls' | 'first_token' | 'last_token' | 'none';
  dims: number;
  maxTokens: number;
  queryPrefix?: string;
  documentPrefix?: string;
  /** Apply layer norm before normalisation (nomic v1.5). */
  layerNorm?: boolean;
  dtype?: string;
}

/** Known small ONNX embedding models (Transformers.js compatible). */
export const LOCAL_MODEL_PRESETS: Record<string, LocalModelPreset> = {
  'Xenova/all-MiniLM-L6-v2': { pooling: 'mean', dims: 384, maxTokens: 256 },
  'Xenova/all-MiniLM-L12-v2': { pooling: 'mean', dims: 384, maxTokens: 256 },
  'Xenova/all-mpnet-base-v2': { pooling: 'mean', dims: 768, maxTokens: 384 },
  'mixedbread-ai/mxbai-embed-xsmall-v1': { pooling: 'mean', dims: 384, maxTokens: 512 },
  'Xenova/bge-small-en-v1.5': {
    pooling: 'cls',
    dims: 384,
    maxTokens: 512,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  'Xenova/bge-base-en-v1.5': {
    pooling: 'cls',
    dims: 768,
    maxTokens: 512,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  'Xenova/bge-m3': { pooling: 'cls', dims: 1024, maxTokens: 8192 },
  'Snowflake/snowflake-arctic-embed-s': {
    pooling: 'cls',
    dims: 384,
    maxTokens: 512,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  'Snowflake/snowflake-arctic-embed-m': {
    pooling: 'cls',
    dims: 768,
    maxTokens: 512,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
  },
  'onnx-community/granite-embedding-small-english-r2-ONNX': {
    pooling: 'cls',
    dims: 384,
    maxTokens: 8192,
  },
  'nomic-ai/nomic-embed-text-v1.5': {
    pooling: 'mean',
    dims: 768,
    maxTokens: 8192,
    queryPrefix: 'search_query: ',
    documentPrefix: 'search_document: ',
    layerNorm: true,
  },
  'onnx-community/embeddinggemma-300m-ONNX': {
    pooling: 'mean',
    dims: 768,
    maxTokens: 2048,
    queryPrefix: 'task: search result | query: ',
    documentPrefix: 'title: none | text: ',
    dtype: 'q8',
  },
  'Xenova/multilingual-e5-small': {
    pooling: 'mean',
    dims: 384,
    maxTokens: 512,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
  },
  'Xenova/e5-small-v2': {
    pooling: 'mean',
    dims: 384,
    maxTokens: 512,
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
  },
  'Xenova/gte-small': { pooling: 'mean', dims: 384, maxTokens: 512 },
};

/** Friendly aliases → HF ids. */
export const LOCAL_MODEL_ALIASES: Record<string, string> = {
  minilm: 'Xenova/all-MiniLM-L6-v2',
  'all-minilm': 'Xenova/all-MiniLM-L6-v2',
  default: 'Xenova/all-MiniLM-L6-v2',
  fast: 'Xenova/all-MiniLM-L6-v2',
  'bge-small': 'Xenova/bge-small-en-v1.5',
  'bge-base': 'Xenova/bge-base-en-v1.5',
  'bge-m3': 'Xenova/bge-m3',
  granite: 'onnx-community/granite-embedding-small-english-r2-ONNX',
  quality: 'onnx-community/granite-embedding-small-english-r2-ONNX',
  'arctic-s': 'Snowflake/snowflake-arctic-embed-s',
  nomic: 'nomic-ai/nomic-embed-text-v1.5',
  embeddinggemma: 'onnx-community/embeddinggemma-300m-ONNX',
  gemma: 'onnx-community/embeddinggemma-300m-ONNX',
  best: 'onnx-community/embeddinggemma-300m-ONNX',
  mxbai: 'mixedbread-ai/mxbai-embed-xsmall-v1',
  'e5-small': 'Xenova/e5-small-v2',
  'multilingual-e5-small': 'Xenova/multilingual-e5-small',
};

export const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

export function defaultModelCacheDir(): string {
  return (
    process.env.WEBVECTOR_MODEL_CACHE ??
    join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'webvector', 'models')
  );
}

export interface LocalEmbeddingsOptions {
  model?: string;
  dtype?: string;
  device?: string;
  cacheDir?: string;
  allowRemoteModels?: boolean;
  batchSize?: number;
  logger?: Logger;
  /** Override preset (pooling etc.) for unknown models. */
  preset?: Partial<LocalModelPreset>;
  /** Called with download progress. */
  onProgress?: (p: { status: string; file?: string; progress?: number }) => void;
}

/**
 * Local ONNX embeddings via `@huggingface/transformers` (optional peer dependency).
 * Default: Xenova/all-MiniLM-L6-v2 q8 (~23 MB, 384 dims). Model files cached under
 * ~/.cache/webvector/models (WEBVECTOR_MODEL_CACHE).
 */
export class LocalEmbeddings implements EmbeddingProvider {
  readonly id = 'local';
  readonly model: string;
  /** Effective weight dtype (part of the persistent embedding-cache key). */
  get dtype(): string {
    return this.opts.dtype ?? this.preset.dtype ?? 'q8';
  }
  private readonly preset: LocalModelPreset;
  private pipe?: Promise<any>;
  private readonly batchSize: number;
  constructor(private readonly opts: LocalEmbeddingsOptions = {}) {
    const raw = opts.model ?? DEFAULT_LOCAL_MODEL;
    this.model = LOCAL_MODEL_ALIASES[raw.toLowerCase()] ?? raw;
    const known = LOCAL_MODEL_PRESETS[this.model];
    this.preset = {
      pooling: 'mean',
      dims: 0,
      maxTokens: 512,
      ...known,
      ...opts.preset,
    } as LocalModelPreset;
    this.batchSize = opts.batchSize ?? 32;
  }

  limits(): EmbeddingLimits {
    return {
      maxBatchSize: this.batchSize,
      maxTokensPerInput: this.preset.maxTokens,
      maxInputChars: Math.max(400, this.preset.maxTokens * 4),
    };
  }

  async dimensions(): Promise<number> {
    if (this.preset.dims) return this.preset.dims;
    const [v] = await this.embed(['dimension probe']);
    this.preset.dims = v!.length;
    return this.preset.dims;
  }

  async init(): Promise<void> {
    await this.pipeline();
  }

  private pipeline(): Promise<any> {
    if (!this.pipe) {
      this.pipe = (async () => {
        let tf: any;
        try {
          tf = await importOptional(
            '@huggingface/transformers',
            'local embeddings (embeddings.provider: local)',
            this.id,
          );
        } catch (err) {
          if (WebVectorError.is(err, 'MISSING_DEPENDENCY')) {
            throw new WebVectorError(err.message, {
              code: 'MISSING_DEPENDENCY',
              provider: this.id,
              remediation: `${err.remediation} — or use \`embeddings.provider: 'none'\` for lexical-only (BM25) mode, or set an API key (OPENAI_API_KEY, …) for a hosted provider.`,
              cause: err,
            });
          }
          throw err;
        }
        tf.env.cacheDir = this.opts.cacheDir ?? defaultModelCacheDir();
        if (this.opts.allowRemoteModels === false) tf.env.allowRemoteModels = false;
        const dtype = this.opts.dtype ?? this.preset.dtype ?? 'q8';
        const t0 = Date.now();
        this.opts.logger?.info(`local embeddings: loading ${this.model} (${dtype})…`);
        try {
          const pipe = await tf.pipeline('feature-extraction', this.model, {
            dtype,
            device: this.opts.device ?? 'cpu',
            progress_callback: this.opts.onProgress,
          });
          this.opts.logger?.info(`local embeddings: ${this.model} ready in ${Date.now() - t0}ms`);
          return pipe;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new WebVectorError(`Failed to load local embedding model "${this.model}": ${msg}`, {
            code: 'EMBEDDING_FAILED',
            provider: this.id,
            remediation: /fetch|network|ENOTFOUND|403|404|Could not locate/i.test(msg)
              ? `The model files could not be downloaded from the Hugging Face Hub. Check connectivity/proxy, or pre-download into ${tf.env.cacheDir} and set embeddings.allowRemoteModels=false. Known-good models: ${Object.keys(LOCAL_MODEL_PRESETS).slice(0, 5).join(', ')}.`
              : `Try a different dtype (embeddings.dtype: 'fp32') or model (embeddings.model: 'Xenova/all-MiniLM-L6-v2').`,
            cause: err,
          });
        }
      })();
      this.pipe.catch(() => {
        this.pipe = undefined;
      });
    }
    return this.pipe;
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const pipe = await this.pipeline();
    const kind: EmbedKind = opts.kind ?? 'document';
    const prefix =
      kind === 'query' ? (this.preset.queryPrefix ?? '') : (this.preset.documentPrefix ?? '');
    const maxChars = this.limits().maxInputChars ?? 2000;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      if (opts.signal?.aborted)
        throw new WebVectorError('Embedding aborted', { code: 'ABORTED', provider: this.id });
      const batch = texts
        .slice(i, i + this.batchSize)
        .map((t) => prefix + (t.length > maxChars ? t.slice(0, maxChars) : t));
      const tensor = await pipe(batch, {
        pooling: this.preset.pooling === 'none' ? 'mean' : this.preset.pooling,
        normalize: !this.preset.layerNorm,
      });
      let list: number[][];
      if (this.preset.layerNorm) {
        // nomic: layer_norm over hidden dim, then L2 normalise
        list = (tensor as any).tolist();
        list = list.map((v) => {
          const mean = v.reduce((a, b) => a + b, 0) / v.length;
          const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
          const sd = Math.sqrt(variance + 1e-5);
          return v.map((x) => (x - mean) / sd);
        });
      } else {
        list = (tensor as any).tolist();
      }
      for (const v of list) out.push(l2Normalize(toFloat32(v)));
      // free tensor memory
      try {
        (tensor as any).dispose?.();
      } catch {
        /* ignore */
      }
    }
    return out;
  }
}
