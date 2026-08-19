/**
 * Builds the long-lived collaborators a WebVector instance uses (search stack, embedder, store,
 * fetcher, parsers, caches, expander, reranker) from the resolved configuration.
 */

import type { WebVectorConfig, WebVectorFileConfig } from '../config/index.js';
import { autoEmbeddingProviderName, createEmbeddingProvider } from '../embeddings/index.js';
import { WebVectorError } from '../errors.js';
import { loadTokenCounter, type TokenCounter } from '../ingest/chunker.js';
import { Fetcher, PageCache } from '../ingest/index.js';
import { createParsers } from '../ingest/parsers.js';
import { createReranker, LlmReranker } from '../rerankers/index.js';
import type { BM25Options } from '../retrieval/bm25.js';
import { HeuristicExpander, LlmExpander } from '../retrieval/expansion.js';
import { buildSearchStack, type FallbackSearchProvider } from '../search/index.js';
import { createVectorStore } from '../stores/index.js';
import { MemoryVectorStore } from '../stores/memory.js';
import type {
  ContentParser,
  EmbeddingProvider,
  LlmFn,
  Logger,
  QueryExpander,
  Reranker,
  VectorStore,
} from '../types.js';
import { SessionRegistry } from './session.js';

export interface Components {
  search: FallbackSearchProvider;
  /** Undefined in lexical-only mode (embeddings.provider: 'none'). */
  embedder?: EmbeddingProvider;
  dimensions: number;
  /** External store shared by all sessions; undefined for the in-memory store. */
  sharedStore?: VectorStore;
  fetcher: Fetcher;
  parsers: ContentParser[];
  pageCache: PageCache;
  expander: QueryExpander;
  reranker?: Reranker;
  countTokens: TokenCounter;
  sessions: SessionRegistry;
  /** Lexical index options (shared by registered and ephemeral sessions). */
  bm25Options: BM25Options;
}

export function bm25OptionsFrom(b: WebVectorFileConfig['retrieval']['bm25']): BM25Options {
  return {
    variant: b.variant,
    k1: b.k1,
    b: b.b,
    delta: b.delta,
    coverageWeight: b.coverageWeight,
    proximityWeight: b.proximityWeight,
    fieldWeights: {
      title: b.fields.title,
      breadcrumb: b.fields.breadcrumb,
      body: b.fields.body,
      lead: b.fields.lead,
    },
  };
}

export async function buildComponents(
  cfg: WebVectorFileConfig,
  code: WebVectorConfig,
  logger: Logger,
): Promise<Components> {
  const fetchImpl = code.fetch;

  const search = buildSearchStack({
    primary: cfg.search.provider,
    primaryInstance: code.search?.instance,
    fallbacks: cfg.search.fallbackProviders,
    fallbackInstances: code.search?.fallbackInstances,
    opts: {
      apiKey: cfg.search.apiKey,
      baseUrl: cfg.search.baseUrl,
      cx: cfg.search.cx,
      timeoutMs: cfg.search.timeoutMs,
      fetch: fetchImpl,
      options: cfg.search.options,
    },
    logger,
  });

  const embedder = code.embeddings?.instance ?? (await resolveEmbedder(cfg, code, logger));
  await embedder?.init?.();
  const dimensions = embedder ? await embedder.dimensions() : 0;

  let sharedStore = code.store?.instance;
  if (!sharedStore && cfg.store.provider !== 'memory') {
    if (!embedder) {
      logger.warn(
        `store.provider "${cfg.store.provider}" is ignored in lexical-only mode (no vectors to store).`,
      );
    } else {
      sharedStore = createVectorStore(cfg.store.provider, {
        url: cfg.store.url,
        apiKey: cfg.store.apiKey,
        collection: cfg.store.collection,
        options: cfg.store.options,
        logger,
      });
    }
  }
  if (sharedStore && embedder) await sharedStore.init?.(dimensions, embedder.model);
  else sharedStore = undefined;
  if (sharedStore && cfg.store.mode === 'ephemeral') {
    logger.warn(
      'store.mode is "ephemeral" but an external store is configured; ephemeral calls still write to it under a per-call session id.',
    );
  }

  const bm25Options = bm25OptionsFrom(cfg.retrieval.bm25);
  const sessions = new SessionRegistry({
    ttlMs: cfg.store.sessionTtlMs,
    maxSessions: cfg.store.maxSessions,
    sharedStore: !!sharedStore,
    storeFactory: () => sharedStore ?? new MemoryVectorStore(),
    bm25: bm25Options,
  });

  const fetcher = new Fetcher({ ...cfg.ingestion, fetch: fetchImpl, logger });
  const parsers = createParsers(cfg.ingestion.parsers, {
    strategy: cfg.ingestion.html.strategy,
    useJsonLdBody: cfg.ingestion.html.useJsonLdBody,
  });
  const pageCache = new PageCache(cfg.ingestion.cache);

  const llm = code.retrieval?.llm;
  const expander =
    code.retrieval?.expander ?? (llm ? new LlmExpander(llm) : new HeuristicExpander());
  const reranker = code.retrieval?.reranker ?? resolveReranker(cfg, llm, logger);
  const countTokens = await loadTokenCounter();

  logger.info(
    `webvector ready: search=${search.id} embeddings=${embedder ? `${embedder.id}/${embedder.model} (${dimensions}d)` : 'none (lexical BM25)'} store=${sharedStore?.id ?? 'memory'}/${cfg.store.mode}`,
  );
  return {
    search,
    embedder,
    dimensions,
    sharedStore,
    fetcher,
    parsers,
    pageCache,
    expander,
    reranker,
    countTokens,
    sessions,
    bm25Options,
  };
}

/** Resolve `embeddings.provider` ('auto' → local | hosted-with-key | none). Undefined = lexical mode. */
async function resolveEmbedder(
  cfg: WebVectorFileConfig,
  code: WebVectorConfig,
  logger: Logger,
): Promise<EmbeddingProvider | undefined> {
  let name = cfg.embeddings.provider;
  if (name === 'auto') {
    const auto = await autoEmbeddingProviderName();
    name = auto.name;
    if (name === 'none') {
      logger.warn(
        "embeddings: no local model runtime or API key found — running in lexical-only mode (BM25 over full pages). For semantic search: npm i @huggingface/transformers, or set OPENAI_API_KEY (or another provider key). Silence this with embeddings.provider: 'none'.",
      );
    } else logger.debug(`embeddings: auto-selected "${name}" (${auto.reason})`);
  }
  if (name === 'none' || name === 'lexical') return undefined;
  return createEmbeddingProvider(name, {
    model: cfg.embeddings.model,
    apiKey: cfg.embeddings.apiKey,
    baseUrl: cfg.embeddings.baseUrl,
    dimensions: cfg.embeddings.dimensions,
    batchSize: cfg.embeddings.batchSize,
    cacheDir: cfg.embeddings.cacheDir,
    dtype: cfg.embeddings.dtype,
    device: cfg.embeddings.device,
    allowRemoteModels: cfg.embeddings.allowRemoteModels,
    timeoutMs: cfg.embeddings.timeoutMs,
    options: cfg.embeddings.options,
    fetch: code.fetch,
    logger,
  });
}

function resolveReranker(
  cfg: WebVectorFileConfig,
  llm: LlmFn | undefined,
  logger: Logger,
): Reranker | undefined {
  const rr = cfg.retrieval.rerank;
  if (!rr) return undefined;
  const name = rr === true ? (llm ? 'llm' : 'local') : rr;
  if (name === 'llm') {
    if (!llm) {
      throw new WebVectorError(
        'retrieval.rerank is "llm" but no retrieval.llm function was provided.',
        {
          code: 'INVALID_CONFIG',
          remediation:
            'Pass `retrieval.llm: (prompt) => Promise<string>` in code config, or choose rerank: cohere | voyage | jina | local.',
        },
      );
    }
    return new LlmReranker(llm);
  }
  return createReranker(name, {
    apiKey: cfg.retrieval.rerankApiKey,
    model: cfg.retrieval.rerankModel,
    cacheDir: cfg.embeddings.cacheDir,
    logger,
  });
}
