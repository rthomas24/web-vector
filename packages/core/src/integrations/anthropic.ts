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
import { runFetchTool } from '../pipeline/fetch-tool.js';
import { renderMarkdown } from '../pipeline/format.js';
import {
  canonicalToolName,
  type JsonSchema,
  TOOL_NAMES,
  toResearchOptions,
  WEB_FETCH_TOOL_NAME,
  WEB_RESEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  type WebVectorToolName,
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

export type ToolInclude = WebVectorToolName | 'web_research' | 'web_fetch' | 'web_search';

/** Anthropic tool definitions for webvector_research (+ optionally webvector_fetch / webvector_search). */
export function anthropicTools(
  opts: { include?: ToolInclude[]; cacheControl?: boolean } = {},
): AnthropicToolDefinition[] {
  const include = (opts.include ?? TOOL_NAMES).map(canonicalToolName);
  const defs = [
    webResearchToolDefinition(),
    webFetchToolDefinition(),
    webSearchToolDefinition(),
  ].filter((d) => include.includes(d.name));
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
    name = canonicalToolName(name);
    if (name === WEB_RESEARCH_TOOL_NAME) {
      const parsed = webResearchInputSchema.parse(input);
      const maxTokens = opts.maxOutputTokens ?? parsed.max_tokens ?? 3000;
      const res = await wv.research(
        parsed.query,
        toResearchOptions(parsed, { signal: opts.signal, maxOutputTokens: maxTokens }),
      );
      return {
        content: res.markdown ?? renderMarkdown(res, { maxTokens }),
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
      const out = await runFetchTool(wv, parsed, { signal: opts.signal });
      return { content: out.text, data: out.structured };
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
