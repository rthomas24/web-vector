/**
 * LangChain.js integration. Requires `@langchain/core` (or `langchain`) in the host project.
 *
 * ```ts
 * import { createAgent } from 'langchain';
 * import { WebVector } from 'webvector';
 * import { langchainTools } from 'webvector/langchain';
 *
 * const wv = new WebVector();
 * const agent = createAgent({ model, tools: await langchainTools(wv) });
 * ```
 */
import { importOptional } from '../errors.js';
import { runFetchTool } from '../pipeline/fetch-tool.js';
import { renderMarkdown } from '../pipeline/format.js';
import {
  canonicalToolName,
  TOOL_NAMES,
  toResearchOptions,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_TOOL_NAME,
  WEB_RESEARCH_DESCRIPTION,
  WEB_RESEARCH_TOOL_NAME,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  webFetchInputSchema,
  webResearchInputSchema,
  webSearchInputSchema,
} from '../pipeline/tool.js';
import type { WebVector } from '../pipeline/webvector.js';
import type { ToolInclude } from './anthropic.js';

/** Build LangChain `tool()` instances for webvector_research, webvector_fetch, webvector_search. */
export async function langchainTools(
  wv: WebVector,
  opts: {
    include?: ToolInclude[];
    maxOutputTokens?: number;
  } = {},
): Promise<any[]> {
  const mod: any = await importOptional(
    '@langchain/core/tools',
    'the LangChain integration (webvector/langchain)',
  );
  const tool = mod.tool;
  const include = (opts.include ?? TOOL_NAMES).map(canonicalToolName);
  const out: any[] = [];
  if (include.includes(WEB_RESEARCH_TOOL_NAME)) {
    out.push(
      tool(
        async (input: any, runtime: any) => {
          const res = await wv.research(
            input.query,
            toResearchOptions(input, {
              signal: runtime?.signal,
              maxOutputTokens: opts.maxOutputTokens ?? input.max_tokens ?? 3000,
            }),
          );
          return [res.markdown ?? renderMarkdown(res), res];
        },
        {
          name: WEB_RESEARCH_TOOL_NAME,
          description: WEB_RESEARCH_DESCRIPTION,
          schema: webResearchInputSchema,
          responseFormat: 'content_and_artifact',
        },
      ),
    );
  }
  if (include.includes(WEB_FETCH_TOOL_NAME)) {
    out.push(
      tool(
        async (input: any, runtime: any) => {
          if (input.query) {
            const res = await wv.fetchAndRetrieve(input.url, input.query, {
              topK: input.top_k,
              signal: runtime?.signal,
            });
            return [res.markdown ?? renderMarkdown(res), res];
          }
          const out = await runFetchTool(wv, input, { signal: runtime?.signal });
          return [out.text, out.structured];
        },
        {
          name: WEB_FETCH_TOOL_NAME,
          description: WEB_FETCH_DESCRIPTION,
          schema: webFetchInputSchema,
          responseFormat: 'content_and_artifact',
        },
      ),
    );
  }
  if (include.includes(WEB_SEARCH_TOOL_NAME)) {
    out.push(
      tool(
        async (input: any, runtime: any) => {
          const results = await wv.search(input.query, {
            count: input.count,
            freshness: input.freshness,
            domainsAllow: input.domains_allow,
            domainsBlock: input.domains_block,
            signal: runtime?.signal,
          });
          return [
            results
              .map(
                (r) => `${r.rank}. ${r.title} — <${r.url}>${r.snippet ? `\n   ${r.snippet}` : ''}`,
              )
              .join('\n') || 'No results.',
            results,
          ];
        },
        {
          name: WEB_SEARCH_TOOL_NAME,
          description: WEB_SEARCH_DESCRIPTION,
          schema: webSearchInputSchema,
          responseFormat: 'content_and_artifact',
        },
      ),
    );
  }
  return out;
}
