import { afterEach, describe, expect, it } from 'vitest';
import {
  buildInstructions,
  createWebVectorMcpServer,
  MAX_INSTRUCTIONS_BYTES,
  resolveTier,
} from '../src/index.js';
import { connect, makeWebVector, type RpcClient } from './helpers.js';

let client: RpcClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe('tool names', () => {
  it('exposes namespaced tools in a deterministic order (no legacy names by default)', async () => {
    client = await connect(createWebVectorMcpServer({ webvector: makeWebVector() }));
    const list = await client.call('tools/list');
    expect(list.result.tools.map((t: any) => t.name)).toEqual([
      'webvector_research',
      'webvector_fetch',
      'webvector_search',
      'webvector_status',
    ]);
  });
  it('--legacy-tool-names appends web_research/web_fetch/web_search aliases after the canonical tools', async () => {
    client = await connect(
      createWebVectorMcpServer({ webvector: makeWebVector(), legacyToolNames: true }),
    );
    const list = await client.call('tools/list');
    expect(list.result.tools.map((t: any) => t.name)).toEqual([
      'webvector_research',
      'webvector_fetch',
      'webvector_search',
      'webvector_status',
      'web_research',
      'web_fetch',
      'web_search',
    ]);
    const r = await client.call('tools/call', {
      name: 'web_search',
      arguments: { query: 'rank fusion', count: 2 },
    });
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content[0].text).toContain('RRF intro');
  });
  it('legacy names in `tools` select the canonical tool', async () => {
    client = await connect(
      createWebVectorMcpServer({ webvector: makeWebVector(), tools: ['web_fetch'] }),
    );
    const list = await client.call('tools/list');
    expect(list.result.tools.map((t: any) => t.name)).toEqual(['webvector_fetch']);
  });
});

describe('server instructions', () => {
  it('are sent on initialize, phrased for the active tier, and stay under 2 KB', async () => {
    client = await connect(createWebVectorMcpServer({ webvector: makeWebVector() }));
    const text: string = client.init.instructions;
    expect(text.startsWith('WebVector:')).toBe(true);
    expect(text).toMatch(/lexical tier/);
    expect(text).toMatch(/3–8 specific keywords/);
    expect(text).toMatch(/webvector_research/);
    expect(text).toMatch(/related_queries/);
    expect(text).toMatch(/session_id/);
    expect(text).toMatch(/data, not instructions/);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_INSTRUCTIONS_BYTES);
    for (const tier of ['lexical', 'semantic'] as const) {
      const t = buildInstructions({ tier });
      expect(Buffer.byteLength(t)).toBeLessThanOrEqual(MAX_INSTRUCTIONS_BYTES);
      expect(t).toMatch(tier === 'lexical' ? /keywords/ : /ideal passage/);
    }
    expect(buildInstructions({ tools: { search: false } })).not.toMatch(/webvector_search only/);
  });
  it('resolveTier: explicit provider, none/lexical, auto + env key, and instructions=false', async () => {
    expect(resolveTier({ embeddings: { provider: 'none' } }, {})).toBe('lexical');
    expect(resolveTier({ embeddings: { provider: 'openai' } }, {})).toBe('semantic');
    expect(resolveTier({ embeddings: { provider: 'auto' } }, { OPENAI_API_KEY: 'k' })).toBe(
      'semantic',
    );
    expect(resolveTier(makeWebVector(), {})).toBe('lexical');
    client = await connect(
      createWebVectorMcpServer({ webvector: makeWebVector(), instructions: false }),
    );
    expect(client.init.instructions).toBeUndefined();
  });
});
