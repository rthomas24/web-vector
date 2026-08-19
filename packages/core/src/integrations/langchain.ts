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
import { renderMarkdown } from '../pipeline/format.js';
import {
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

/** Build LangChain `tool()` instances for web_research, web_fetch, web_search. */
export async function langchainTools(
  wv: WebVector,
  opts: {
    include?: ('web_research' | 'web_fetch' | 'web_search')[];
    maxOutputTokens?: number;
  } = {},
): Promise<any[]> {
  const mod: any = await importOptional(
    '@langchain/core/tools',
    'the LangChain integration (webvector/langchain)',
  );
  const tool = mod.tool;
  const include = opts.include ?? ['web_research', 'web_fetch', 'web_search'];
  const out: any[] = [];
  if (include.includes('web_research')) {
    out.push(
      tool(
        async (input: any, runtime: any) => {
          const res = await wv.research(
            input.query,
            toResearchOptions(input, {
              signal: runtime?.signal,
              maxOutputTokens: opts.maxOutputTokens ?? 3000,
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
  if (include.includes('web_fetch')) {
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
          const doc = await wv.fetch(input.url, { signal: runtime?.signal });
          const max = input.max_chars ?? 40_000;
          return [`# ${doc.title}\n<${doc.url}>\n\n${doc.markdown.slice(0, max)}`, doc];
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
  if (include.includes('web_search')) {
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
