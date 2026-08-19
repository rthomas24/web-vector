/**
 * Per-call usage accounting (`stats.usage`, the `usage` event). A meter is bound to the async
 * context of one research()/fetch() call via AsyncLocalStorage, so provider wrappers deep in the
 * pipeline (embedder, reranker, fetch coordinator) can attribute work to the right call without
 * threading a parameter through every stage.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  EmbeddingProvider,
  EmbedOptions,
  HttpUsage,
  Reranker,
  ScoredChunk,
  UsageStats,
} from '../types.js';

const als = new AsyncLocalStorage<UsageMeter>();

export class UsageMeter {
  readonly usage: UsageStats;
  constructor(init: { search: string; embedProvider: string; embedModel: string }) {
    this.usage = {
      search: { provider: init.search, calls: 0 },
      embed: {
        provider: init.embedProvider,
        model: init.embedModel,
        requests: 0,
        texts: 0,
        tokens: 0,
        cached: 0,
      },
      http: { requests: 0, bytes: 0, cacheHits: 0, notModified: 0, coalesced: 0, negativeHits: 0 },
    };
  }
  get http(): HttpUsage {
    return this.usage.http;
  }
  /** Run `fn` with this meter as the ambient meter for its whole async subtree. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return als.run(this, fn);
  }
}

/** The meter of the call currently executing (undefined outside research()/fetch()). */
export function currentUsage(): UsageMeter | undefined {
  return als.getStore();
}

/** Approximate token count for pricing/usage (chars / 4; providers rarely return usage). */
export function approxTokenCount(texts: string[]): number {
  let chars = 0;
  for (const t of texts) chars += t.length;
  return Math.ceil(chars / 4);
}

/** Wrap an embedder so every embed() request is attributed to the ambient usage meter. */
export function meteredEmbedder(inner: EmbeddingProvider): EmbeddingProvider {
  return {
    id: inner.id,
    model: inner.model,
    dtype: inner.dtype,
    dimensions: () => inner.dimensions(),
    limits: () => inner.limits(),
    init: inner.init ? () => inner.init!() : undefined,
    async embed(texts: string[], opts?: EmbedOptions) {
      const m = currentUsage();
      if (m && texts.length) {
        m.usage.embed.requests++;
        m.usage.embed.texts += texts.length;
        m.usage.embed.tokens = (m.usage.embed.tokens ?? 0) + approxTokenCount(texts);
      }
      return inner.embed(texts, opts);
    },
  };
}

/** Wrap a reranker so calls are attributed to the ambient usage meter. */
export function meteredReranker(inner: Reranker): Reranker {
  return {
    id: inner.id,
    async rerank(
      query: string,
      chunks: ScoredChunk[],
      opts?: { topN?: number; signal?: AbortSignal },
    ) {
      const m = currentUsage();
      if (m) {
        m.usage.rerank ??= { provider: inner.id, requests: 0, documents: 0 };
        m.usage.rerank.requests++;
        m.usage.rerank.documents += chunks.length;
      }
      return inner.rerank(query, chunks, opts);
    },
  };
}
