import { z } from 'zod';
import type { ResearchOptions } from '../types.js';

/**
 * Canonical (namespaced) tool names. `webvector_*` avoids colliding with Anthropic's built-in
 * `web_search`/`web_fetch` server tools and Claude Code's WebSearch/WebFetch, and lets permission
 * rules, hooks and tool-search target them unambiguously.
 */
export const WEB_RESEARCH_TOOL_NAME = 'webvector_research';

/**
 * Tool descriptions follow the "Best for / Not for / Returns / Common mistakes / Example" pattern
 * with the key sentence first, and each stays under 2 KB (Claude Code truncates there). They are
 * static: no tier/version text (that lives in the server instructions and webvector_status), so
 * tools/list is deterministic and prompt-cache friendly. The untrusted-content notice is in the
 * results themselves, not here.
 */
export const WEB_RESEARCH_DESCRIPTION = [
  'Research a question on the live web: one call runs a search, reads the FULL content of the top pages (HTML/PDF), and returns only the passages that answer the query, each cited as [n] Title — url.',
  'Best for: facts, quotes, numbers, code, API/CLI details, comparisons, "what changed in", anything where a snippet is not enough or knowledge may be stale.',
  'Not for: reading one known URL (use webvector_fetch); just listing result links (use webvector_search); questions answerable without the web.',
  'Returns: ranked passages ([n] Title — url + verbatim text), a Sources list, suggested follow-up queries; trimmed to max_tokens with an explicit "N omitted" footer. Zero passages is not an error — the result says what to try next.',
  'Common mistakes: long conversational queries (use 3–8 specific keywords incl. names/versions/years); calling repeatedly with tiny variations instead of one call with 2–3 related_queries; passing a URL as the query; hand-tuning top_k/max_pages when depth: "thorough" does it in one word.',
  'Example: {"query": "Node 24 AbortSignal.any behaviour", "related_queries": ["AbortSignal.any example", "AbortSignal.any memory leak fix"], "depth": "balanced"}.',
].join(' ');

export const WEB_FETCH_TOOL_NAME = 'webvector_fetch';
export const WEB_FETCH_DESCRIPTION = [
  'Fetch one URL and return its main content as clean Markdown (HTML, PDF, plain text), or — with query — only the passages of that page relevant to the query.',
  'Best for: a URL the user gave you, a Source from webvector_research/webvector_search you want in full, docs/changelogs/README pages, PDFs.',
  'Not for: discovering pages (use webvector_search) or answering open questions (use webvector_research); pages that need login or JavaScript rendering.',
  'Returns: "# Title", the URL, then Markdown; long pages are cut at max_length (default 20000 chars) on a paragraph boundary with "Content truncated at char A of B — call again with start_index=A"; include_links appends a deduped link list; selector/exclude_selectors keep or drop parts of the DOM (CSS).',
  'Common mistakes: fetching every search result instead of asking webvector_research once; forgetting start_index for the rest of a long page; passing max_length far above what you will read.',
  'Example: {"url": "https://nodejs.org/api/globals.html", "query": "AbortSignal.any"} or {"url": "https://example.com/spec", "start_index": 20000}.',
].join(' ');

export const WEB_SEARCH_TOOL_NAME = 'webvector_search';
export const WEB_SEARCH_DESCRIPTION = [
  'Run a web search and return result URLs, titles and snippets only — no page content is fetched.',
  'Best for: checking what exists (which sites/pages cover a topic), finding an official URL to pass to webvector_fetch, quick freshness checks, or inspecting the SERP when webvector_research returned no passages.',
  'Not for: answering questions from content — snippets are ~150 characters and often wrong; use webvector_research for that.',
  'Returns: numbered results "rank. Title / url / snippet" plus a one-line hint to read a result with webvector_fetch.',
  'Common mistakes: quoting snippets as facts; searching and then fetching each result by hand instead of one webvector_research call; domain filters with schemes or paths (use bare domains like "docs.python.org").',
  'Example: {"query": "MCP specification 2026-07-28 changelog", "count": 5, "freshness": "year"}.',
].join(' ');

export const WEBVECTOR_STATUS_TOOL_NAME = 'webvector_status';
export const WEBVECTOR_STATUS_DESCRIPTION =
  'Show the resolved WebVector configuration (secrets redacted), the active search/embedding providers and tier (lexical or semantic), and session counts. Best for debugging "why did research return nothing" or checking which providers/keys are active. Not for research. Takes no arguments.';

/** Claude Code truncates tool descriptions at 2 KB; keep every description under this. */
export const MAX_DESCRIPTION_BYTES = 2048;

export type WebVectorToolName = 'webvector_research' | 'webvector_fetch' | 'webvector_search';
/** Pre-0.2 names, still accepted by the runners and exposable as MCP aliases (`--legacy-tool-names`). */
export const LEGACY_TOOL_NAMES: Record<string, WebVectorToolName> = {
  web_research: WEB_RESEARCH_TOOL_NAME,
  web_fetch: WEB_FETCH_TOOL_NAME,
  web_search: WEB_SEARCH_TOOL_NAME,
};
export const TOOL_NAMES: readonly WebVectorToolName[] = [
  WEB_RESEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
];
/** Map a legacy or canonical tool name to its canonical form (unknown names pass through). */
export function canonicalToolName(name: string): string {
  return LEGACY_TOOL_NAMES[name] ?? name;
}

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
    .describe(
      'Pages already read are reused automatically; pass a session_id only to isolate parallel investigations (same id across their calls).',
    ),
  response_format: z
    .enum(['concise', 'detailed'])
    .optional()
    .describe(
      'concise (default): passages + sources only. detailed: adds per-passage score/date, failed fetches and timings.',
    ),
  max_tokens: z
    .number()
    .int()
    .min(500)
    .max(20_000)
    .optional()
    .describe(
      'Approximate token budget for the returned text (default 4000). Passages that do not fit are omitted with an explicit footer naming their indices.',
    ),
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
  response_format: z
    .enum(['concise', 'detailed'])
    .optional()
    .describe('Shape of the passages output when query is given (default concise).'),
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
    output: z.object({ chars: z.number(), approxTokens: z.number() }).optional(),
  }),
  markdown: z.string().optional(),
  degraded: z.enum(['search_only', 'partial']).optional(),
  sessionId: z.string().optional(),
});

/**
 * Slim structured output (the MCP server's default `--structured slim`): what a model or app needs
 * to cite and follow up, without stats/offsets. Some clients serialise structuredContent into the
 * prompt next to the text content, so it must stay small.
 */
export const webResearchSlimOutputSchema = z.object({
  query: z.string(),
  passages: z.array(
    z.object({
      index: z.number().int(),
      url: z.string(),
      title: z.string(),
      text: z.string(),
      score: z.number(),
      publishedAt: z.string().optional(),
    }),
  ),
  sources: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      status: z.enum(['ok', 'failed', 'skipped', 'cached']),
      chunks: z.number().int(),
    }),
  ),
  degraded: z.enum(['search_only', 'partial']).optional(),
  session_id: z.string().optional(),
  suggested_queries: z.array(z.string()).optional(),
  /** Passage indices dropped to fit max_tokens. */
  omitted: z.array(z.number().int()).optional(),
  /** What to try next when the result is empty or degraded. */
  hint: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type WebResearchSlimOutput = z.infer<typeof webResearchSlimOutputSchema>;

/** Project a ResearchResult onto the slim structured shape. */
export function toSlimOutput(
  r: import('../types.js').ResearchResult,
  extra: Partial<
    Pick<
      WebResearchSlimOutput,
      'session_id' | 'suggested_queries' | 'omitted' | 'hint' | 'retryable'
    >
  > = {},
): WebResearchSlimOutput {
  return {
    query: r.query,
    passages: r.passages.map((p) => ({
      index: p.index,
      url: p.url,
      title: p.title,
      text: p.text,
      score: p.score,
      ...(p.publishedAt ? { publishedAt: p.publishedAt } : {}),
    })),
    sources: r.sources.map((s) => ({
      url: s.url,
      title: s.title,
      status: s.status,
      chunks: s.chunks,
    })),
    ...(r.degraded ? { degraded: r.degraded } : {}),
    ...(extra.session_id ? { session_id: extra.session_id } : {}),
    ...(extra.suggested_queries?.length ? { suggested_queries: extra.suggested_queries } : {}),
    ...(extra.omitted?.length ? { omitted: extra.omitted } : {}),
    ...(extra.hint ? { hint: extra.hint } : {}),
    ...(extra.retryable !== undefined ? { retryable: extra.retryable } : {}),
  };
}

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
    responseFormat: input.response_format,
    maxOutputTokens: input.max_tokens,
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
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
