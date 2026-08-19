/**
 * Anthropic Messages API integration (no SDK dependency required).
 *
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * import { WebVector } from 'webvector';
 * import { anthropicTools, runAnthropicTool } from 'webvector/anthropic';
 *
 * const wv = new WebVector();
 * const client = new Anthropic();
 * const tools = anthropicTools();                       // [{ name, description, input_schema }, …]
 * let messages = [{ role: 'user', content: 'What is RRF?' }];
 * for (;;) {
 *   const res = await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 1024, tools, messages });
 *   const uses = res.content.filter((c) => c.type === 'tool_use');
 *   if (!uses.length) break;
 *   messages.push({ role: 'assistant', content: res.content });
 *   const results = await Promise.all(uses.map((u) => runAnthropicTool(wv, u.name, u.input)));
 *   messages.push({ role: 'user', content: uses.map((u, i) => ({ type: 'tool_result', tool_use_id: u.id, content: results[i].content, is_error: results[i].isError })) });
 * }
 * ```
 */
import { WebVectorError } from '../errors.js';
import { renderMarkdown } from '../pipeline/format.js';
import {
  type JsonSchema,
  toResearchOptions,
  WEB_FETCH_TOOL_NAME,
  WEB_RESEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  webFetchInputSchema,
  webFetchToolDefinition,
  webResearchInputSchema,
  webResearchToolDefinition,
  webSearchInputSchema,
  webSearchToolDefinition,
} from '../pipeline/tool.js';
import type { WebVector } from '../pipeline/webvector.js';

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
  cache_control?: { type: 'ephemeral' };
}

/** Anthropic tool definitions for web_research (+ optionally web_fetch / web_search). */
export function anthropicTools(
  opts: { include?: ('web_research' | 'web_fetch' | 'web_search')[]; cacheControl?: boolean } = {},
): AnthropicToolDefinition[] {
  const include = opts.include ?? ['web_research', 'web_fetch', 'web_search'];
  const defs = [
    webResearchToolDefinition(),
    webFetchToolDefinition(),
    webSearchToolDefinition(),
  ].filter((d) => include.includes(d.name as any));
  return defs.map((d, i) => ({
    name: d.name,
    description: d.description,
    input_schema: d.inputSchema,
    ...(opts.cacheControl && i === defs.length - 1
      ? { cache_control: { type: 'ephemeral' as const } }
      : {}),
  }));
}

export interface ToolRunResult {
  content: string;
  isError?: boolean;
  /** Full structured result (for app-side use). */
  data?: unknown;
}

/** Execute a WebVector tool call by name with raw (already-parsed JSON) input. Never throws — returns is_error content instead. */
export async function runAnthropicTool(
  wv: WebVector,
  name: string,
  input: unknown,
  opts: { signal?: AbortSignal; maxOutputTokens?: number } = {},
): Promise<ToolRunResult> {
  return runTool(wv, name, input, opts);
}

/** Generic executor shared by the Anthropic and OpenAI bindings. */
export async function runTool(
  wv: WebVector,
  name: string,
  input: unknown,
  opts: { signal?: AbortSignal; maxOutputTokens?: number } = {},
): Promise<ToolRunResult> {
  try {
    if (name === WEB_RESEARCH_TOOL_NAME) {
      const parsed = webResearchInputSchema.parse(input);
      const res = await wv.research(
        parsed.query,
        toResearchOptions(parsed, {
          signal: opts.signal,
          maxOutputTokens: opts.maxOutputTokens ?? 3000,
        }),
      );
      return {
        content: res.markdown ?? renderMarkdown(res, { maxTokens: opts.maxOutputTokens ?? 3000 }),
        data: res,
      };
    }
    if (name === WEB_FETCH_TOOL_NAME) {
      const parsed = webFetchInputSchema.parse(input);
      if (parsed.query) {
        const res = await wv.fetchAndRetrieve(parsed.url, parsed.query, {
          topK: parsed.top_k,
          signal: opts.signal,
        });
        return { content: res.markdown ?? renderMarkdown(res), data: res };
      }
      const doc = await wv.fetch(parsed.url, { signal: opts.signal });
      const max = parsed.max_chars ?? 40_000;
      const md =
        doc.markdown.length > max ? `${doc.markdown.slice(0, max)}\n\n…(truncated)` : doc.markdown;
      return { content: `# ${doc.title}\n<${doc.url}>\n\n${md}`, data: doc };
    }
    if (name === WEB_SEARCH_TOOL_NAME) {
      const parsed = webSearchInputSchema.parse(input);
      const results = await wv.search(parsed.query, {
        count: parsed.count,
        freshness: parsed.freshness,
        domainsAllow: parsed.domains_allow,
        domainsBlock: parsed.domains_block,
        signal: opts.signal,
      });
      return {
        content:
          results
            .map((r) => `${r.rank}. ${r.title} — <${r.url}>${r.snippet ? `\n   ${r.snippet}` : ''}`)
            .join('\n') || 'No results.',
        data: results,
      };
    }
    return { content: `Unknown tool: ${name}`, isError: true };
  } catch (err) {
    const e = WebVectorError.from(err, { code: 'INTERNAL' });
    return { content: `Error (${e.code}): ${e.describe()}`, isError: true, data: e.toJSON() };
  }
}
