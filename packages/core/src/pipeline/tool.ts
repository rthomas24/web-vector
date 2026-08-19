import { z } from 'zod';
import type { ResearchOptions } from '../types.js';

export const WEB_RESEARCH_TOOL_NAME = 'web_research';

export const WEB_RESEARCH_DESCRIPTION =
  'Research a question on the live web. Runs a web search, reads the FULL content of the top pages (HTML/PDF), embeds them, and returns only the passages most relevant to the query, each with its source URL, title and relevance score. Prefer this over plain web search when you need facts, quotes, numbers, code, or up-to-date details from actual page content. Returns cited passages (not whole pages). Pass related_queries to widen coverage and session_id to reuse pages already read in this conversation.';

export const WEB_FETCH_TOOL_NAME = 'web_fetch';
export const WEB_FETCH_DESCRIPTION =
  'Fetch a single URL and return its main content as Markdown (HTML, PDF and text supported). Use when you already know the exact page you need — typically a URL the user gave you or one returned by web_search/web_research. Optionally pass a query to return only the most relevant passages instead of the whole page.';

export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const WEB_SEARCH_DESCRIPTION =
  'Run a web search and return result URLs, titles and snippets (no page fetching). Cheaper than web_research; use it to discover pages or when snippets are enough.';

export const webResearchInputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(500)
    .describe('The primary information need, phrased as a search query or question.'),
  related_queries: z
    .array(z.string().min(2).max(300))
    .max(6)
    .optional()
    .describe('Optional alternative phrasings or sub-questions to broaden retrieval.'),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Number of passages to return (default 12).'),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('Maximum number of pages to fetch and read (default 10).'),
  freshness: z
    .enum(['day', 'week', 'month', 'year'])
    .optional()
    .describe('Restrict search results by recency where the search provider supports it.'),
  domains_allow: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Only include results from these domains (e.g. ["docs.python.org"]).'),
  domains_block: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Exclude results from these domains.'),
  session_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Reuse pages already ingested in this conversation; pass the same id across calls.'),
});
export type WebResearchInput = z.infer<typeof webResearchInputSchema>;

export const webFetchInputSchema = z.object({
  url: z.string().url().describe('Absolute http(s) URL to fetch.'),
  query: z
    .string()
    .max(500)
    .optional()
    .describe('If given, return only the passages most relevant to this query.'),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Passages to return when query is given (default 8).'),
  max_chars: z
    .number()
    .int()
    .min(500)
    .max(200_000)
    .optional()
    .describe('Truncate the returned Markdown to this many characters (default 40000).'),
});
export type WebFetchInput = z.infer<typeof webFetchInputSchema>;

export const webSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  count: z.number().int().min(1).max(30).optional().describe('Number of results (default 10).'),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  domains_allow: z.array(z.string()).max(20).optional(),
  domains_block: z.array(z.string()).max(20).optional(),
});
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

const passageSchema = z.object({
  index: z.number().int(),
  text: z.string(),
  url: z.string(),
  title: z.string(),
  score: z.number(),
  cosine: z.number().optional(),
  bm25: z.number().optional(),
  rerankScore: z.number().optional(),
  chunkIndex: z.number().int(),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
  siteName: z.string().optional(),
  publishedAt: z.string().optional(),
  fetchedAt: z.string(),
  matchedQueries: z.array(z.string()),
  citation: z.string(),
  fromSnippet: z.boolean().optional(),
});

const failureSchema = z.object({
  url: z.string().optional(),
  code: z.string(),
  message: z.string(),
  stage: z.string(),
  provider: z.string().optional(),
});

export const webResearchOutputSchema = z.object({
  query: z.string(),
  queries: z.array(z.string()),
  passages: z.array(passageSchema),
  sources: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      status: z.enum(['ok', 'failed', 'skipped', 'cached']),
      chunks: z.number().int(),
      bestScore: z.number().optional(),
      passageIndices: z.array(z.number().int()),
      contentType: z.string().optional(),
      fetchedAt: z.string().optional(),
      searchRank: z.number().int(),
      bytes: z.number().optional(),
      ms: z.number().optional(),
      failure: failureSchema.optional(),
    }),
  ),
  failures: z.array(failureSchema),
  stats: z.object({
    search: z.object({
      provider: z.string(),
      attempts: z.array(
        z.object({
          provider: z.string(),
          ok: z.boolean(),
          ms: z.number(),
          error: z.string().optional(),
        }),
      ),
      resultCount: z.number(),
      ms: z.number(),
    }),
    ingest: z.object({
      requested: z.number(),
      fetched: z.number(),
      ok: z.number(),
      failed: z.number(),
      cached: z.number(),
      bytes: z.number(),
      ms: z.number(),
    }),
    embed: z.object({
      provider: z.string(),
      model: z.string(),
      dimensions: z.number(),
      chunks: z.number(),
      cached: z.number(),
      batches: z.number(),
      ms: z.number(),
    }),
    retrieve: z.object({
      candidates: z.number(),
      queries: z.number(),
      reranked: z.boolean(),
      ms: z.number(),
    }),
    totalMs: z.number(),
    warnings: z.array(z.string()),
  }),
  markdown: z.string().optional(),
  degraded: z.enum(['search_only', 'partial']).optional(),
  sessionId: z.string().optional(),
});

/** Convert tool input (snake_case) to ResearchOptions. */
export function toResearchOptions(
  input: WebResearchInput,
  extra: Partial<ResearchOptions> = {},
): ResearchOptions {
  return {
    relatedQueries: input.related_queries,
    topK: input.top_k,
    maxPages: input.max_pages,
    freshness: input.freshness,
    domainsAllow: input.domains_allow,
    domainsBlock: input.domains_block,
    sessionId: input.session_id,
    ...extra,
  };
}

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

function toJsonSchema(schema: z.ZodType, opts: { strict?: boolean } = {}): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchema;
  json.$schema = undefined;
  if (opts.strict) makeStrict(json);
  return JSON.parse(JSON.stringify(json));
}

/** OpenAI strict mode: every property required, optionals become nullable, additionalProperties false. */
function makeStrict(node: any): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object' && node.properties) {
    node.additionalProperties = false;
    const req = new Set<string>(node.required ?? []);
    for (const [k, v] of Object.entries<any>(node.properties)) {
      if (!req.has(k)) {
        if (Array.isArray(v.type)) {
          if (!v.type.includes('null')) v.type.push('null');
        } else if (v.type) v.type = [v.type, 'null'];
        else if (v.anyOf) v.anyOf.push({ type: 'null' });
        else v.type = 'null';
      }
      makeStrict(v);
    }
    node.required = Object.keys(node.properties);
  }
  if (node.items) makeStrict(node.items);
  for (const key of ['anyOf', 'oneOf', 'allOf'])
    if (Array.isArray(node[key])) node[key].forEach(makeStrict);
}

/** JSON-schema tool definitions usable with any function-calling API. */
export function webResearchToolDefinition(
  opts: { strict?: boolean; includeOutputSchema?: boolean } = {},
): ToolDefinition {
  return {
    name: WEB_RESEARCH_TOOL_NAME,
    description: WEB_RESEARCH_DESCRIPTION,
    inputSchema: toJsonSchema(webResearchInputSchema, opts),
    ...(opts.includeOutputSchema ? { outputSchema: toJsonSchema(webResearchOutputSchema) } : {}),
  };
}
export function webFetchToolDefinition(opts: { strict?: boolean } = {}): ToolDefinition {
  return {
    name: WEB_FETCH_TOOL_NAME,
    description: WEB_FETCH_DESCRIPTION,
    inputSchema: toJsonSchema(webFetchInputSchema, opts),
  };
}
export function webSearchToolDefinition(opts: { strict?: boolean } = {}): ToolDefinition {
  return {
    name: WEB_SEARCH_TOOL_NAME,
    description: WEB_SEARCH_DESCRIPTION,
    inputSchema: toJsonSchema(webSearchInputSchema, opts),
  };
}
