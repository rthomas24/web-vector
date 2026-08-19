/**
 * Static list-price table for the opt-in cost ESTIMATE (`telemetry.pricing: true`).
 *
 * Prices change, tiers differ, and free quotas exist — treat every number here as an approximate
 * public list price at `PRICING_AS_OF`, not a bill. Override or extend with
 * `telemetry.pricing: { embed: { 'openai/text-embedding-3-small': 0.02 }, ... }`.
 * A copy is written to docs/pricing.json by `npm run build` (packages/core/scripts/generate.ts).
 */
import type { UsageStats } from '../types.js';

export const PRICING_AS_OF = '2026-08';

export interface PriceTable {
  /** USD per 1M input tokens, keyed by `provider/model` (or `provider/*`). */
  embed: Record<string, number>;
  /** USD per 1 000 search calls, keyed by provider id. Keyless providers are 0. */
  search: Record<string, number>;
  /** USD per 1 000 rerank requests, keyed by provider id. */
  rerank: Record<string, number>;
}

export const DEFAULT_PRICING: PriceTable = {
  embed: {
    'openai/text-embedding-3-small': 0.02,
    'openai/text-embedding-3-large': 0.13,
    'openai/text-embedding-ada-002': 0.1,
    'voyage/voyage-3.5-lite': 0.02,
    'voyage/voyage-3.5': 0.06,
    'voyage/voyage-3-large': 0.18,
    'cohere/embed-v4.0': 0.12,
    'cohere/embed-english-v3.0': 0.1,
    'cohere/embed-multilingual-v3.0': 0.1,
    'mistral/mistral-embed': 0.1,
    'jina/jina-embeddings-v3': 0.02,
    'gemini/gemini-embedding-001': 0.15,
    'local/*': 0,
    'ollama/*': 0,
    'none/*': 0,
  },
  search: {
    duckduckgo: 0,
    'tavily-keyless': 0,
    wikipedia: 0,
    searxng: 0,
    brave: 5,
    serper: 1,
    serpapi: 15,
    tavily: 8,
    exa: 5,
    perplexity: 5,
    'google-cse': 5,
  },
  rerank: {
    cohere: 2,
    voyage: 0.05,
    jina: 0.02,
    local: 0,
    llm: 0,
  },
};

/** Merge user overrides (partial, per section) over the defaults. */
export function resolvePricing(override?: Partial<PriceTable> | boolean): PriceTable {
  if (!override || override === true) return DEFAULT_PRICING;
  return {
    embed: { ...DEFAULT_PRICING.embed, ...override.embed },
    search: { ...DEFAULT_PRICING.search, ...override.search },
    rerank: { ...DEFAULT_PRICING.rerank, ...override.rerank },
  };
}

function lookup(
  table: Record<string, number>,
  provider: string,
  model?: string,
): number | undefined {
  if (model !== undefined) {
    return table[`${provider}/${model}`] ?? table[`${provider}/*`];
  }
  return table[provider];
}

/** Estimated USD for one call's usage; undefined when nothing priceable was used. */
export function estimateCostUsd(usage: UsageStats, pricing: PriceTable): number | undefined {
  let usd = 0;
  let priced = false;
  const s = lookup(pricing.search, usage.search.provider);
  if (s !== undefined) {
    usd += (usage.search.calls / 1000) * s;
    priced = true;
  }
  const e = lookup(pricing.embed, usage.embed.provider, usage.embed.model);
  if (e !== undefined && usage.embed.tokens) {
    usd += (usage.embed.tokens / 1_000_000) * e;
    priced = true;
  }
  if (usage.rerank) {
    const r = lookup(pricing.rerank, usage.rerank.provider);
    if (r !== undefined) {
      usd += (usage.rerank.requests / 1000) * r;
      priced = true;
    }
  }
  return priced ? Math.round(usd * 1e6) / 1e6 : undefined;
}

export const PRICING_NOTE = `estimate from static list prices as of ${PRICING_AS_OF} (tokens ≈ chars/4); not a bill — check your provider dashboard`;
