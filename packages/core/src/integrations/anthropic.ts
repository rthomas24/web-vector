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
import { ToolGuard, type ToolGuardOptions } from '../pipeline/guard.js';
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
import type { ResearchResult } from '../types.js';

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
  cache_control?: { type: 'ephemeral' };
}

export type ToolInclude = WebVectorToolName | 'web_research' | 'web_fetch' | 'web_search';

/**
 * Operator guardrails for the adapters — parity with Anthropic's built-in web tools
 * (`max_uses`, `allowed_domains`, `blocked_domains`, `user_location`). Pass the same object to
 * `anthropicTools()` (documents the policy in the descriptions) and to `runAnthropicTool()` /
 * `runOpenAITool()` (enforces it; the use counter is kept per WebVector instance).
 */
export interface AdapterGuardOptions extends ToolGuardOptions {
  /** Share one guard across calls explicitly (default: one per WebVector instance). */
  guard?: ToolGuard;
}

const guards = new WeakMap<WebVector, ToolGuard>();
/** The guard used for `wv` (created from `opts` on first use). */
export function guardFor(wv: WebVector, opts: AdapterGuardOptions = {}): ToolGuard {
  if (opts.guard) return opts.guard;
  let g = guards.get(wv);
  if (!g) {
    g = new ToolGuard(opts);
    guards.set(wv, g);
  }
  return g;
}

function policySuffix(opts: AdapterGuardOptions): string {
  const bits: string[] = [];
  if (opts.allowedDomains?.length)
    bits.push(`Only these domains: ${opts.allowedDomains.join(', ')}.`);
  if (opts.blockedDomains?.length)
    bits.push(`Never these domains: ${opts.blockedDomains.join(', ')}.`);
  if (opts.maxUses !== undefined)
    bits.push(`At most ${opts.maxUses} web tool calls per conversation.`);
  return bits.length ? ` Policy: ${bits.join(' ')}` : '';
}

/** Anthropic tool definitions for webvector_research (+ optionally webvector_fetch / webvector_search). */
export function anthropicTools(
  opts: { include?: ToolInclude[]; cacheControl?: boolean } & AdapterGuardOptions = {},
): AnthropicToolDefinition[] {
  const include = (opts.include ?? TOOL_NAMES).map(canonicalToolName);
  const defs = [
    webResearchToolDefinition(),
    webFetchToolDefinition(),
    webSearchToolDefinition(),
  ].filter((d) => include.includes(d.name));
  const suffix = policySuffix(opts);
  return defs.map((d, i) => ({
    name: d.name,
    description: d.description + suffix,
    input_schema: d.inputSchema,
    ...(opts.cacheControl && i === defs.length - 1
      ? { cache_control: { type: 'ephemeral' as const } }
      : {}),
  }));
}

/** Anthropic `search_result` content block (native citations, no beta header). */
export interface AnthropicSearchResultBlock {
  type: 'search_result';
  source: string;
  title: string;
  content: { type: 'text'; text: string }[];
  citations?: { enabled: boolean };
  cache_control?: { type: 'ephemeral' };
}
export type AnthropicToolResultContent =
  | string
  | (AnthropicSearchResultBlock | { type: 'text'; text: string })[];

export interface ToolRunResult {
  content: string;
  isError?: boolean;
  /** Full structured result (for app-side use). */
  data?: unknown;
}

export interface AnthropicToolRunResult extends Omit<ToolRunResult, 'content'> {
  /** Plain markdown, or (`format: 'search_result'`) an array of `search_result` blocks + a text block. */
  content: AnthropicToolResultContent;
}

export interface RunToolOptions extends AdapterGuardOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

/**
 * Execute a WebVector tool call by name with raw (already-parsed JSON) input. Never throws — returns
 * is_error content instead. With `format: 'search_result'`, research/fetch(query) results come back
 * as `search_result` content blocks (`[{type:'search_result', source, title, content:[{type:'text',
 * text}], citations:{enabled:true}}, …]`) — put the array in `tool_result.content` and Claude emits
 * native `search_result_location` citations with `cited_text`.
 */
export async function runAnthropicTool(
  wv: WebVector,
  name: string,
  input: unknown,
  opts: RunToolOptions & { format?: 'markdown' | 'search_result' } = {},
): Promise<AnthropicToolRunResult> {
  const r = await runTool(wv, name, input, opts);
  if (opts.format !== 'search_result' || r.isError) return r;
  const res = r.data as Partial<ResearchResult> | undefined;
  if (!res || !Array.isArray(res.passages)) return r;
  return { ...r, content: toSearchResultBlocks(res as ResearchResult) };
}

/** Convert a ResearchResult into Anthropic `search_result` blocks (+ a trailing text block with the Sources list). */
export function toSearchResultBlocks(
  res: ResearchResult,
  opts: { citations?: boolean; maxPassages?: number } = {},
): (AnthropicSearchResultBlock | { type: 'text'; text: string })[] {
  const passages = res.passages.slice(0, opts.maxPassages ?? res.passages.length);
  const blocks: (AnthropicSearchResultBlock | { type: 'text'; text: string })[] = passages.map(
    (p) => ({
      type: 'search_result' as const,
      source: p.url,
      title: p.title,
      content: [{ type: 'text' as const, text: p.text }],
      citations: { enabled: opts.citations ?? true },
    }),
  );
  if (blocks.length === 0)
    blocks.push({
      type: 'text',
      text: 'No relevant passages. Try synonyms, drop freshness/domain filters, or a related query.',
    });
  const sources = res.sources.filter((s) => s.status === 'ok' || s.status === 'cached');
  if (sources.length)
    blocks.push({
      type: 'text',
      text: `Sources: ${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('; ')}`,
    });
  return blocks;
}

/** Generic executor shared by the Anthropic and OpenAI bindings. */
export async function runTool(
  wv: WebVector,
  name: string,
  input: unknown,
  opts: RunToolOptions = {},
): Promise<ToolRunResult> {
  try {
    name = canonicalToolName(name);
    const guard = guardFor(wv, opts);
    if (name === WEB_RESEARCH_TOOL_NAME) {
      const parsed = guard.applyDomains(webResearchInputSchema.parse(input));
      guard.consume();
      const maxTokens = opts.maxOutputTokens ?? parsed.max_tokens ?? 3000;
      const res = await wv.research(
        parsed.query,
        toResearchOptions(parsed, {
          signal: opts.signal,
          maxOutputTokens: maxTokens,
          ...guard.searchLocation(),
        }),
      );
      return {
        content: res.markdown ?? renderMarkdown(res, { maxTokens }),
        data: res,
      };
    }
    if (name === WEB_FETCH_TOOL_NAME) {
      const parsed = webFetchInputSchema.parse(input);
      guard.assertUrlAllowed(parsed.url);
      guard.consume();
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
      const parsed = guard.applyDomains(webSearchInputSchema.parse(input));
      guard.consume();
      const results = await wv.search(parsed.query, {
        count: parsed.count,
        freshness: parsed.freshness,
        domainsAllow: parsed.domains_allow,
        domainsBlock: parsed.domains_block,
        signal: opts.signal,
        ...guard.searchLocation(),
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
