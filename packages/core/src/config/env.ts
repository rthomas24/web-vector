import type { WebVectorConfig } from './schema.js';

/** Conventional environment variable names for provider API keys (first match wins). */
export const PROVIDER_KEY_ENV: Record<string, string[]> = {
  // search
  brave: ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY'],
  serper: ['SERPER_API_KEY'],
  serpapi: ['SERPAPI_API_KEY', 'SERPAPI_KEY'],
  'google-cse': ['GOOGLE_CSE_KEY', 'GOOGLE_API_KEY'],
  tavily: ['TAVILY_API_KEY'],
  exa: ['EXA_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  // embeddings
  openai: ['OPENAI_API_KEY'],
  'openai-compatible': ['OPENAI_COMPATIBLE_API_KEY', 'OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'],
  voyage: ['VOYAGE_API_KEY'],
  cohere: ['COHERE_API_KEY', 'CO_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  jina: ['JINA_API_KEY'],
  // stores
  qdrant: ['QDRANT_API_KEY'],
  chroma: ['CHROMA_API_KEY'],
};

export const PROVIDER_URL_ENV: Record<string, string[]> = {
  searxng: ['SEARXNG_URL', 'SEARXNG_BASE_URL'],
  ollama: ['OLLAMA_HOST', 'OLLAMA_BASE_URL'],
  'openai-compatible': ['OPENAI_COMPATIBLE_BASE_URL', 'OPENAI_BASE_URL'],
  chroma: ['CHROMA_URL'],
  qdrant: ['QDRANT_URL'],
  pgvector: ['PGVECTOR_URL', 'DATABASE_URL', 'POSTGRES_URL'],
};

export function envKeyFor(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of PROVIDER_KEY_ENV[provider] ?? []) {
    const v = env[name];
    if (v) return v;
  }
  return undefined;
}

export function envUrlFor(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of PROVIDER_URL_ENV[provider] ?? []) {
    const v = env[name];
    if (v) return v;
  }
  return undefined;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function list(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `WEBVECTOR_CACHE_DIR`: a path, `auto`, or `false|off|memory|0` for memory-only. */
function cacheDir(v: string): string | false {
  return ['false', 'off', 'memory', '0', 'none'].includes(v.trim().toLowerCase()) ? false : v;
}

/** Read WEBVECTOR_* environment variables into a partial config. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): WebVectorConfig {
  const cfg: WebVectorConfig = {
    search: {
      provider: env.WEBVECTOR_SEARCH_PROVIDER,
      apiKey: env.WEBVECTOR_SEARCH_API_KEY,
      cx: env.GOOGLE_CSE_CX ?? env.WEBVECTOR_SEARCH_CX,
      baseUrl: env.WEBVECTOR_SEARCH_BASE_URL,
      resultsPerQuery: num(env.WEBVECTOR_RESULTS_PER_QUERY),
      safeSearch: env.WEBVECTOR_SAFE_SEARCH as 'off' | 'moderate' | 'strict' | undefined,
      country: env.WEBVECTOR_SEARCH_COUNTRY,
      language: env.WEBVECTOR_SEARCH_LANGUAGE,
      fallbackProviders: list(env.WEBVECTOR_SEARCH_FALLBACKS),
    },
    embeddings: {
      provider: env.WEBVECTOR_EMBEDDINGS_PROVIDER,
      model: env.WEBVECTOR_EMBEDDINGS_MODEL,
      apiKey: env.WEBVECTOR_EMBEDDINGS_API_KEY,
      baseUrl: env.WEBVECTOR_EMBEDDINGS_BASE_URL,
      dimensions: num(env.WEBVECTOR_EMBEDDINGS_DIMENSIONS),
      batchSize: num(env.WEBVECTOR_EMBEDDINGS_BATCH_SIZE),
      cacheDir: env.WEBVECTOR_MODEL_CACHE,
      dtype: env.WEBVECTOR_EMBEDDINGS_DTYPE,
      device: env.WEBVECTOR_EMBEDDINGS_DEVICE,
      allowRemoteModels: bool(env.WEBVECTOR_ALLOW_REMOTE_MODELS),
    },
    store: {
      provider: env.WEBVECTOR_STORE_PROVIDER,
      mode: env.WEBVECTOR_STORE_MODE as 'ephemeral' | 'session' | 'persistent' | undefined,
      collection: env.WEBVECTOR_STORE_COLLECTION,
      url: env.WEBVECTOR_STORE_URL,
      apiKey: env.WEBVECTOR_STORE_API_KEY,
      sessionTtlMs: num(env.WEBVECTOR_SESSION_TTL_MS),
    },
    retrieval: {
      topK: num(env.WEBVECTOR_TOP_K),
      queryExpansion: bool(env.WEBVECTOR_QUERY_EXPANSION),
      maxExpandedQueries: num(env.WEBVECTOR_MAX_EXPANDED_QUERIES),
      hybrid: bool(env.WEBVECTOR_HYBRID),
      mmr: bool(env.WEBVECTOR_MMR),
      maxPerSource: num(env.WEBVECTOR_MAX_PER_SOURCE),
      rerank:
        env.WEBVECTOR_RERANK === undefined
          ? undefined
          : (bool(env.WEBVECTOR_RERANK) ?? env.WEBVECTOR_RERANK),
      rerankModel: env.WEBVECTOR_RERANK_MODEL,
      rerankApiKey: env.WEBVECTOR_RERANK_API_KEY,
    },
    ingestion: {
      maxPages: num(env.WEBVECTOR_MAX_PAGES),
      maxConcurrentFetches: num(env.WEBVECTOR_MAX_CONCURRENT_FETCHES),
      timeoutMs: num(env.WEBVECTOR_FETCH_TIMEOUT_MS),
      totalDeadlineMs: num(env.WEBVECTOR_TOTAL_DEADLINE_MS),
      respectRobotsTxt: bool(env.WEBVECTOR_RESPECT_ROBOTS),
      userAgent: env.WEBVECTOR_USER_AGENT,
      allowPrivateNetworks: bool(env.WEBVECTOR_ALLOW_PRIVATE_NETWORKS),
      chunkSize: num(env.WEBVECTOR_CHUNK_SIZE),
      chunkOverlap: num(env.WEBVECTOR_CHUNK_OVERLAP),
      cache: env.WEBVECTOR_CACHE_DIR ? { dir: cacheDir(env.WEBVECTOR_CACHE_DIR) } : undefined,
    },
    output: { markdown: bool(env.WEBVECTOR_OUTPUT_MARKDOWN) },
    telemetry: {
      otel: bool(env.WEBVECTOR_OTEL),
      pricing: bool(env.WEBVECTOR_PRICING),
    },
    logging: {
      level: env.WEBVECTOR_LOG_LEVEL as 'silent' | 'error' | 'warn' | 'info' | 'debug' | undefined,
    },
  };
  return stripUndefined(cfg) as WebVectorConfig;
}

/** Recursively drop `undefined` values and empty plain objects; leaves class instances/functions alone. */
export function stripUndefined<T>(obj: T): T {
  if (!isPlainObject(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (isPlainObject(v)) {
      const inner = stripUndefined(v);
      if (Object.keys(inner).length === 0) continue;
      out[k] = inner;
    } else out[k] = v;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
