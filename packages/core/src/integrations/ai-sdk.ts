/**
 * Vercel AI SDK (v7) integration. `ai` is an optional peer dependency — this module only imports
 * types from it and receives the runtime `tool`/`embedMany`/`generateText` functions lazily.
 *
 * ```ts
 * import { generateText, isStepCount } from 'ai';
 * import { anthropic } from '@ai-sdk/anthropic';
 * import { WebVector } from 'webvector';
 * import { webResearchTool } from 'webvector/ai-sdk';
 *
 * const wv = new WebVector();
 * const { text } = await generateText({
 *   model: anthropic('claude-sonnet-5'),
 *   tools: { webvector_research: await webResearchTool(wv) },
 *   stopWhen: isStepCount(5),
 *   prompt: 'What changed in the MCP spec in 2026?',
 * });
 * ```
 */
import type { EmbeddingModel, LanguageModel, RerankingModel, Tool } from 'ai';
import { importOptional } from '../errors.js';
import { runFetchTool } from '../pipeline/fetch-tool.js';
import { type ResponseFormat, renderMarkdown, suggestedQueriesFor } from '../pipeline/format.js';
import {
  toResearchOptions,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_TOOL_NAME,
  WEB_RESEARCH_DESCRIPTION,
  WEB_RESEARCH_TOOL_NAME,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  type WebFetchInput,
  type WebResearchInput,
  type WebSearchInput,
  webFetchInputSchema,
  webResearchInputSchema,
  webResearchOutputSchema,
  webSearchInputSchema,
} from '../pipeline/tool.js';
import type { WebVector } from '../pipeline/webvector.js';
import type {
  EmbeddingProvider,
  EmbedKind,
  LlmFn,
  Reranker,
  ResearchResult,
  ScoredChunk,
} from '../types.js';
import { l2Normalize, toFloat32 } from '../util/vector.js';

type AiModule = typeof import('ai');

async function ai(): Promise<AiModule> {
  return importOptional<AiModule>('ai', 'the Vercel AI SDK integration (webvector/ai-sdk)');
}

export interface AiSdkToolOptions {
  /** What the model sees. Default: rendered markdown (compact). Set 'json' to send the structured result. */
  modelOutput?: 'markdown' | 'json';
  /** Markdown shape sent to the model (default `concise`); the app still gets the full ResearchResult. */
  responseFormat?: ResponseFormat;
  /** Approx token budget for the markdown sent to the model (default 3000). */
  maxOutputTokens?: number;
  /** Extra research options applied on every call (e.g. a fixed sessionId). */
  defaults?: Partial<Parameters<WebVector['research']>[1]>;
}

/** `webvector_research` as an AI SDK tool. */
export async function webResearchTool(
  wv: WebVector,
  opts: AiSdkToolOptions = {},
): Promise<Tool<WebResearchInput, ResearchResult>> {
  const { tool } = await ai();
  return tool({
    description: WEB_RESEARCH_DESCRIPTION,
    inputSchema: webResearchInputSchema,
    outputSchema: webResearchOutputSchema as any,
    execute: async (input: WebResearchInput, { abortSignal }: { abortSignal?: AbortSignal }) =>
      wv.research(
        input.query,
        toResearchOptions(input, {
          signal: abortSignal,
          maxOutputTokens: opts.maxOutputTokens ?? input.max_tokens ?? 3000,
          ...opts.defaults,
        }),
      ),
    toModelOutput: ({ output }: { output: ResearchResult }) =>
      opts.modelOutput === 'json'
        ? { type: 'json' as const, value: stripForModel(output) as any }
        : {
            type: 'text' as const,
            value: renderMarkdown(output, {
              maxTokens: opts.maxOutputTokens ?? 3000,
              format: opts.responseFormat ?? 'concise',
              suggestedQueries: suggestedQueriesFor(output),
            }),
          },
  } as any) as Tool<WebResearchInput, ResearchResult>;
}

/** `webvector_fetch` as an AI SDK tool. */
export async function webFetchTool(wv: WebVector): Promise<Tool<WebFetchInput, unknown>> {
  const { tool } = await ai();
  return tool({
    description: WEB_FETCH_DESCRIPTION,
    inputSchema: webFetchInputSchema,
    execute: async (input: WebFetchInput, { abortSignal }: { abortSignal?: AbortSignal }) => {
      if (input.query)
        return wv.fetchAndRetrieve(input.url, input.query, {
          topK: input.top_k,
          signal: abortSignal,
        });
      const out = await runFetchTool(wv, input, { signal: abortSignal });
      return { ...out.structured, markdown: out.text };
    },
    toModelOutput: ({ output }: { output: any }) => ({
      type: 'text' as const,
      value: output.markdown ?? JSON.stringify(output),
    }),
  } as any) as Tool<WebFetchInput, unknown>;
}

/** `webvector_search` as an AI SDK tool. */
export async function webSearchTool(wv: WebVector): Promise<Tool<WebSearchInput, unknown>> {
  const { tool } = await ai();
  return tool({
    description: WEB_SEARCH_DESCRIPTION,
    inputSchema: webSearchInputSchema,
    execute: async (input: WebSearchInput, { abortSignal }: { abortSignal?: AbortSignal }) =>
      wv.search(input.query, {
        count: input.count,
        freshness: input.freshness,
        domainsAllow: input.domains_allow,
        domainsBlock: input.domains_block,
        signal: abortSignal,
      }),
  } as any) as Tool<WebSearchInput, unknown>;
}

/** All three tools keyed by their canonical names. */
export async function webVectorTools(
  wv: WebVector,
  opts: AiSdkToolOptions = {},
): Promise<Record<string, Tool<any, any>>> {
  const [research, fetch, search] = await Promise.all([
    webResearchTool(wv, opts),
    webFetchTool(wv),
    webSearchTool(wv),
  ]);
  return {
    [WEB_RESEARCH_TOOL_NAME]: research,
    [WEB_FETCH_TOOL_NAME]: fetch,
    [WEB_SEARCH_TOOL_NAME]: search,
  };
}

function stripForModel(r: ResearchResult) {
  return {
    query: r.query,
    passages: r.passages.map((p) => ({
      index: p.index,
      text: p.text,
      url: p.url,
      title: p.title,
      score: p.score,
      publishedAt: p.publishedAt,
    })),
    sources: r.sources
      .filter((s) => s.status !== 'failed')
      .map((s) => ({ url: s.url, title: s.title })),
    failures: r.failures.length,
    degraded: r.degraded,
  };
}

// ─── Bridges: use any AI SDK provider for embeddings / reranking / LLM hooks ──

export interface AiSdkEmbeddingOptions {
  id?: string;
  dimensions?: number;
  /** providerOptions for query vs document calls (e.g. cohere inputType, voyage inputType, google taskType). */
  queryProviderOptions?: Record<string, Record<string, unknown>>;
  documentProviderOptions?: Record<string, Record<string, unknown>>;
  maxBatchSize?: number;
}

/** Wrap an AI SDK `EmbeddingModel` (e.g. `openai.embedding('text-embedding-3-small')`) as a WebVector EmbeddingProvider. */
export function fromAiSdkEmbeddingModel(
  model: EmbeddingModel,
  opts: AiSdkEmbeddingOptions = {},
): EmbeddingProvider {
  const modelId = typeof model === 'string' ? model : ((model as any).modelId ?? 'ai-sdk-model');
  const providerId =
    typeof model === 'string' ? 'ai-sdk' : `ai-sdk:${(model as any).provider ?? 'unknown'}`;
  let dims = opts.dimensions;
  const provider: EmbeddingProvider = {
    id: opts.id ?? providerId,
    model: modelId,
    limits: () => ({ maxBatchSize: opts.maxBatchSize ?? 96, maxInputChars: 24_000 }),
    async dimensions() {
      if (dims) return dims;
      const [v] = await provider.embed(['dimension probe']);
      dims = v!.length;
      return dims;
    },
    async embed(texts, o = {}) {
      const { embedMany } = await ai();
      const kind: EmbedKind = o.kind ?? 'document';
      const { embeddings } = await embedMany({
        model,
        values: texts,
        abortSignal: o.signal,
        providerOptions: (kind === 'query'
          ? opts.queryProviderOptions
          : opts.documentProviderOptions) as any,
      });
      return embeddings.map((e: number[]) => l2Normalize(toFloat32(e)));
    },
  };
  return provider;
}

/** Wrap an AI SDK `RerankingModel` (e.g. `cohere.reranking('rerank-v3.5')`) as a WebVector Reranker. */
export function fromAiSdkRerankingModel(
  model: RerankingModel,
  opts: { id?: string; maxDocChars?: number } = {},
): Reranker {
  return {
    id: opts.id ?? `ai-sdk-rerank:${typeof model === 'string' ? model : (model as any).modelId}`,
    async rerank(query, chunks: ScoredChunk[], o = {}) {
      if (chunks.length === 0) return [];
      const { rerank } = await ai();
      const documents = chunks.map((c) =>
        opts.maxDocChars && c.text.length > opts.maxDocChars
          ? c.text.slice(0, opts.maxDocChars)
          : c.text,
      );
      const res: any = await rerank({
        model,
        query,
        documents,
        topN: o.topN,
        abortSignal: o.signal,
      });
      const ranking: { originalIndex: number; score: number }[] = res.ranking ?? [];
      return ranking
        .map((r) => ({ ...(chunks[r.originalIndex] as ScoredChunk), rerankScore: r.score }))
        .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
    },
  };
}

/** Turn an AI SDK `LanguageModel` into the provider-agnostic `LlmFn` used for query expansion / LLM rerank. */
export function llmFromAiSdk(
  model: LanguageModel,
  opts: { maxOutputTokens?: number; temperature?: number } = {},
): LlmFn {
  return async (prompt, o = {}) => {
    const { generateText } = await ai();
    const res: any = await generateText({
      model,
      prompt,
      abortSignal: o.signal,
      maxOutputTokens: opts.maxOutputTokens ?? 400,
      temperature: opts.temperature ?? 0.7,
    } as any);
    return res.text as string;
  };
}
