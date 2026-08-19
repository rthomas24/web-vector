import { z } from 'zod';
import type {
  EmbeddingProvider,
  LlmFn,
  Logger,
  QueryExpander,
  Reranker,
  SearchProvider,
  VectorStore,
} from '../types.js';

// ─── Zod schema for serialisable config (files / env) ────────────────────────

export const searchProviderNames = [
  'duckduckgo',
  'brave',
  'serper',
  'serpapi',
  'google-cse',
  'searxng',
  'tavily',
  'tavily-keyless',
  'exa',
  'perplexity',
  'wikipedia',
] as const;
export type SearchProviderName = (typeof searchProviderNames)[number];

export const embeddingProviderNames = [
  'auto',
  'none',
  'local',
  'openai',
  'openai-compatible',
  'gemini',
  'voyage',
  'cohere',
  'mistral',
  'jina',
  'ollama',
] as const;
export type EmbeddingProviderName = (typeof embeddingProviderNames)[number];

export const storeProviderNames = ['memory', 'chroma', 'qdrant', 'pgvector'] as const;
export type StoreProviderName = (typeof storeProviderNames)[number];

export const rerankerNames = ['cohere', 'voyage', 'jina', 'local'] as const;
export type RerankerName = (typeof rerankerNames)[number];

const freshnessSchema = z.union([
  z.enum(['day', 'week', 'month', 'year']),
  z.object({ after: z.string().optional(), before: z.string().optional() }),
]);

export const searchConfigSchema = z.object({
  provider: z.string().default('duckduckgo'),
  apiKey: z.string().optional(),
  /** google-cse engine id */
  cx: z.string().optional(),
  /** searxng / custom base URL */
  baseUrl: z.string().optional(),
  resultsPerQuery: z.number().int().min(1).max(100).default(10),
  safeSearch: z.enum(['off', 'moderate', 'strict']).default('moderate'),
  country: z.string().optional(),
  language: z.string().optional(),
  freshness: freshnessSchema.optional(),
  fallbackProviders: z.array(z.string()).default(['tavily-keyless', 'wikipedia']),
  timeoutMs: z.number().int().min(1000).default(20_000),
  /** Provider-specific extra options passed through. */
  options: z.record(z.string(), z.unknown()).default({}),
});

export const embeddingsConfigSchema = z.object({
  /**
   * 'auto' (default): local model if @huggingface/transformers is installed, else the first
   * hosted provider with a key in the environment, else 'none'.
   * 'none' | 'lexical': no embeddings — BM25 over the fetched pages (smallest install).
   */
  provider: z.string().default('auto'),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  dimensions: z.number().int().min(16).optional(),
  batchSize: z.number().int().min(1).optional(),
  cacheDir: z.string().optional(),
  /** Local models: 'q8' | 'fp32' | 'fp16' | 'q4' … */
  dtype: z.string().optional(),
  device: z.string().optional(),
  allowRemoteModels: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).default(60_000),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const storeConfigSchema = z.object({
  provider: z.string().default('memory'),
  mode: z.enum(['ephemeral', 'session', 'persistent']).default('ephemeral'),
  collection: z.string().default('webvector'),
  url: z.string().optional(),
  apiKey: z.string().optional(),
  sessionTtlMs: z
    .number()
    .int()
    .min(1000)
    .default(30 * 60_000),
  maxSessions: z.number().int().min(1).default(100),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const retrievalConfigSchema = z.object({
  topK: z.number().int().min(1).max(200).default(12),
  candidateMultiplier: z.number().min(1).default(4),
  queryExpansion: z.boolean().default(true),
  maxExpandedQueries: z.number().int().min(0).max(10).default(4),
  hybrid: z.boolean().default(true),
  rrfK: z.number().min(1).default(60),
  /** Weight of BM25 lists in fusion relative to the original query vector list (1.0). */
  lexicalWeight: z.number().min(0).default(0.5),
  expansionWeight: z.number().min(0).default(0.7),
  maxPerSource: z.number().int().min(1).default(3),
  mmr: z.boolean().default(true),
  mmrLambda: z.number().min(0).max(1).default(0.7),
  minScore: z.number().min(-1).max(1).nullable().default(null),
  relativeCutoff: z.number().min(0).max(1).default(0.6),
  nearDuplicateThreshold: z.number().min(0).max(1).default(0.9),
  rerank: z.union([z.boolean(), z.string()]).default(false),
  rerankModel: z.string().optional(),
  rerankApiKey: z.string().optional(),
  rerankTopN: z.number().int().min(1).default(50),
  fallbackToLexical: z.boolean().default(true),
});

export const ingestionConfigSchema = z.object({
  maxPages: z.number().int().min(1).max(100).default(10),
  maxConcurrentFetches: z.number().int().min(1).max(64).default(8),
  perHostConcurrency: z.number().int().min(1).default(2),
  perHostMinIntervalMs: z.number().int().min(0).default(500),
  timeoutMs: z.number().int().min(1000).default(15_000),
  totalDeadlineMs: z.number().int().min(1000).default(45_000),
  maxRedirects: z.number().int().min(0).max(20).default(5),
  maxBytes: z
    .number()
    .int()
    .min(10_000)
    .default(5 * 1024 * 1024),
  respectRobotsTxt: z.boolean().default(true),
  userAgent: z
    .string()
    .default('Mozilla/5.0 (compatible; WebVector/0.1; +https://github.com/rthomas24/web-vector)'),
  retries: z.number().int().min(0).max(5).default(2),
  allowPrivateNetworks: z.boolean().default(false),
  parsers: z.array(z.string()).default(['html', 'pdf', 'text']),
  chunkSize: z.number().int().min(64).max(4096).default(480),
  chunkOverlap: z.number().int().min(0).default(60),
  maxChunksPerPage: z.number().int().min(1).default(200),
  minChunkChars: z.number().int().min(1).default(100),
  /** Use provider-returned page content (Tavily raw_content / Exa text) instead of fetching when available. */
  useProviderContent: z.boolean().default(true),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      ttlMs: z
        .number()
        .int()
        .min(0)
        .default(15 * 60_000),
      maxPages: z.number().int().min(1).default(500),
      dir: z.string().optional(),
    })
    .default({ enabled: true, ttlMs: 15 * 60_000, maxPages: 500 }),
});

export const outputConfigSchema = z.object({
  markdown: z.boolean().default(true),
  maxPassageChars: z.number().int().min(100).default(1500),
  includeSnippetsOnFailure: z.boolean().default(true),
});

export const loggingConfigSchema = z.object({
  level: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('warn'),
});

export const webVectorFileConfigSchema = z.object({
  search: searchConfigSchema.default(searchConfigSchema.parse({})),
  embeddings: embeddingsConfigSchema.default(embeddingsConfigSchema.parse({})),
  store: storeConfigSchema.default(storeConfigSchema.parse({})),
  retrieval: retrievalConfigSchema.default(retrievalConfigSchema.parse({})),
  ingestion: ingestionConfigSchema.default(ingestionConfigSchema.parse({})),
  output: outputConfigSchema.default(outputConfigSchema.parse({})),
  logging: loggingConfigSchema.default(loggingConfigSchema.parse({})),
});

export type WebVectorFileConfig = z.infer<typeof webVectorFileConfigSchema>;
export type WebVectorFileConfigInput = z.input<typeof webVectorFileConfigSchema>;

/** Deep partial helper for user input. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ─── Code config: serialisable config + instances/functions ─────────────────

export interface WebVectorConfig
  extends DeepPartial<
    Omit<WebVectorFileConfigInput, 'search' | 'embeddings' | 'store' | 'retrieval'>
  > {
  search?: DeepPartial<z.input<typeof searchConfigSchema>> & {
    /** Provide a ready instance instead of a provider name. */
    instance?: SearchProvider;
    /** Instances to try in order when the primary fails. */
    fallbackInstances?: SearchProvider[];
  };
  embeddings?: DeepPartial<z.input<typeof embeddingsConfigSchema>> & {
    instance?: EmbeddingProvider;
  };
  store?: DeepPartial<z.input<typeof storeConfigSchema>> & { instance?: VectorStore };
  retrieval?: DeepPartial<z.input<typeof retrievalConfigSchema>> & {
    reranker?: Reranker;
    expander?: QueryExpander;
    /** Provider-agnostic LLM hook enabling LLM multi-query expansion (and `rerank: 'llm'`). */
    llm?: LlmFn;
  };
  logger?: Logger;
  /** Custom fetch implementation (tests, proxies). */
  fetch?: typeof fetch;
}

/** Identity helper for typed config files. */
export function defineConfig(config: WebVectorConfig): WebVectorConfig {
  return config;
}
