/**
 * OpenAI integration (Responses API + Chat Completions function tools). No SDK dependency required.
 *
 * ```ts
 * import OpenAI from 'openai';
 * import { WebVector } from 'webvector';
 * import { openaiTools, runOpenAITool } from 'webvector/openai';
 *
 * const wv = new WebVector();
 * const client = new OpenAI();
 * let input: any[] = [{ role: 'user', content: 'What is RRF?' }];
 * const tools = openaiTools();                                   // Responses API shape
 * for (;;) {
 *   const res = await client.responses.create({ model: 'gpt-5', input, tools });
 *   const calls = res.output.filter((o) => o.type === 'function_call');
 *   if (!calls.length) { console.log(res.output_text); break; }
 *   input = [...input, ...res.output];
 *   for (const c of calls) input.push({ type: 'function_call_output', call_id: c.call_id, output: (await runOpenAITool(wv, c.name, c.arguments)).content });
 * }
 * ```
 */
import {
  canonicalToolName,
  type JsonSchema,
  TOOL_NAMES,
  webFetchToolDefinition,
  webResearchToolDefinition,
  webSearchToolDefinition,
} from '../pipeline/tool.js';
import type { WebVector } from '../pipeline/webvector.js';
import { runTool, type ToolInclude, type ToolRunResult } from './anthropic.js';

export interface OpenAIResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: boolean;
}
export interface OpenAIChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema; strict?: boolean };
}

/** Responses API tool definitions (`strict: true` schemas by default). */
export function openaiTools(
  opts: { include?: ToolInclude[]; strict?: boolean } = {},
): OpenAIResponsesTool[] {
  const include = (opts.include ?? TOOL_NAMES).map(canonicalToolName);
  const strict = opts.strict ?? true;
  return [
    webResearchToolDefinition({ strict }),
    webFetchToolDefinition({ strict }),
    webSearchToolDefinition({ strict }),
  ]
    .filter((d) => include.includes(d.name))
    .map((d) => ({
      type: 'function' as const,
      name: d.name,
      description: d.description,
      parameters: d.inputSchema,
      strict,
    }));
}

/** Chat Completions tool definitions. */
export function openaiChatTools(
  opts: { include?: ToolInclude[]; strict?: boolean } = {},
): OpenAIChatTool[] {
  return openaiTools(opts).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: t.strict,
    },
  }));
}

/** Execute a tool call. `args` may be the raw JSON string from the model. Strict-mode nulls are stripped. */
export async function runOpenAITool(
  wv: WebVector,
  name: string,
  args: string | Record<string, unknown>,
  opts: { signal?: AbortSignal; maxOutputTokens?: number } = {},
): Promise<ToolRunResult> {
  let input: Record<string, unknown>;
  try {
    input = typeof args === 'string' ? JSON.parse(args || '{}') : (args ?? {});
  } catch (err) {
    return {
      content: `Invalid JSON arguments: ${err instanceof Error ? err.message : err}`,
      isError: true,
    };
  }
  for (const k of Object.keys(input)) if (input[k] === null) delete input[k];
  return runTool(wv, name, input, opts);
}
