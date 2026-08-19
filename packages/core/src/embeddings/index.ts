import { envKeyFor, envUrlFor } from '../config/env.js';
import { WebVectorError } from '../errors.js';
import type { EmbeddingProvider, Logger } from '../types.js';
import type { BaseEmbeddingOptions } from './base.js';
import {
  CohereEmbeddings,
  GeminiEmbeddings,
  JinaEmbeddings,
  MistralEmbeddings,
  OllamaEmbeddings,
  OpenAIEmbeddings,
  VoyageEmbeddings,
} from './hosted.js';
import { LocalEmbeddings, type LocalEmbeddingsOptions } from './local.js';

export type { BaseEmbeddingOptions } from './base.js';
export { customEmbeddingProvider, EmbeddingCache, HttpEmbeddingProvider } from './base.js';
export {
  CohereEmbeddings,
  GeminiEmbeddings,
  JinaEmbeddings,
  MistralEmbeddings,
  OllamaEmbeddings,
  OpenAIEmbeddings,
  VoyageEmbeddings,
} from './hosted.js';
export type { LocalEmbeddingsOptions, LocalModelPreset } from './local.js';
export {
  DEFAULT_LOCAL_MODEL,
  defaultModelCacheDir,
  LOCAL_MODEL_ALIASES,
  LOCAL_MODEL_PRESETS,
  LocalEmbeddings,
} from './local.js';

export interface EmbeddingFactoryOptions
  extends BaseEmbeddingOptions,
    Omit<LocalEmbeddingsOptions, 'model' | 'batchSize' | 'logger'> {
  logger?: Logger;
}

type Factory = (opts: EmbeddingFactoryOptions) => EmbeddingProvider;

const registry = new Map<string, Factory>([
  ['local', (o) => new LocalEmbeddings(o)],
  ['transformers', (o) => new LocalEmbeddings(o)],
  ['openai', (o) => new OpenAIEmbeddings(o)],
  ['openai-compatible', (o) => new OpenAIEmbeddings({ ...o, compatible: true })],
  [
    'lmstudio',
    (o) =>
      new OpenAIEmbeddings({
        ...o,
        compatible: true,
        baseUrl: o.baseUrl ?? 'http://127.0.0.1:1234/v1',
      }),
  ],
  ['gemini', (o) => new GeminiEmbeddings(o)],
  ['google', (o) => new GeminiEmbeddings(o)],
  ['voyage', (o) => new VoyageEmbeddings(o)],
  ['cohere', (o) => new CohereEmbeddings(o)],
  ['mistral', (o) => new MistralEmbeddings(o)],
  ['jina', (o) => new JinaEmbeddings(o)],
  ['ollama', (o) => new OllamaEmbeddings(o)],
]);

export function registerEmbeddingProvider(name: string, factory: Factory): void {
  registry.set(name, factory);
}
export function listEmbeddingProviders(): string[] {
  return [...registry.keys()];
}

export function createEmbeddingProvider(
  name: string,
  opts: EmbeddingFactoryOptions = {},
): EmbeddingProvider {
  if (name === 'none' || name === 'lexical' || name === 'auto') {
    throw new WebVectorError(
      `"${name}" is not an embedding provider instance; WebVector resolves it internally.`,
      {
        code: 'UNKNOWN_PROVIDER',
        remediation:
          "Use `new WebVector({ embeddings: { provider: 'none' } })` for lexical mode, or pass a concrete provider name here.",
      },
    );
  }
  const factory = registry.get(name);
  if (!factory) {
    throw new WebVectorError(`Unknown embedding provider "${name}".`, {
      code: 'UNKNOWN_PROVIDER',
      remediation: `Use one of: ${listEmbeddingProviders().join(', ')} — or register a custom one with registerEmbeddingProvider().`,
    });
  }
  return factory({
    ...opts,
    apiKey: opts.apiKey ?? envKeyFor(name),
    baseUrl: opts.baseUrl ?? envUrlFor(name),
  });
}

/**
 * Resolve `embeddings.provider: 'auto'`: local model if `@huggingface/transformers` is installed,
 * else the first hosted provider whose key is present, else `'none'` (lexical-only BM25 mode).
 */
export async function autoEmbeddingProviderName(): Promise<{ name: string; reason: string }> {
  if (await hasLocalRuntime())
    return { name: 'local', reason: '@huggingface/transformers is installed' };
  for (const name of ['openai', 'voyage', 'gemini', 'cohere', 'mistral', 'jina']) {
    if (envKeyFor(name)) return { name, reason: `${name} API key found in environment` };
  }
  return {
    name: 'none',
    reason: 'no @huggingface/transformers and no embedding API key found — lexical-only mode',
  };
}

/** True when the optional local model runtime is installed. */
export async function hasLocalRuntime(): Promise<boolean> {
  try {
    await import('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

/** Human-readable instructions for enabling semantic search (used by CLI/MCP/logs). */
export const SEMANTIC_UPGRADE_HINT =
  'Enable semantic search with one of: `npm i @huggingface/transformers` (local, no key; ~230 MB runtime), `npx -y -p @huggingface/transformers -p webvector-mcp webvector-mcp` for npx users, or set an API key (OPENAI_API_KEY, VOYAGE_API_KEY, GEMINI_API_KEY, COHERE_API_KEY, …).';
