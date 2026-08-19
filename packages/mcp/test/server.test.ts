import { afterEach, describe, expect, it } from 'vitest';
import { createWebVectorMcpServer } from '../src/index.js';
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
