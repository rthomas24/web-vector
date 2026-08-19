import { customSearchProvider, defineConfig, WebVector } from 'webvector';

// 1) Session mode: pages ingested in the first call are reused by the second (no refetch/re-embed).
const wv = new WebVector(
  defineConfig({
    store: { mode: 'session' },
    retrieval: {
      topK: 6,
      // Optional LLM hook for multi-query expansion / rerank: 'llm'. Any provider works.
      // llm: async (prompt) => (await client.messages.create({...})).content[0].text,
    },
  }),
);
const a = await wv.research('MCP streamable http transport', { sessionId: 'demo' });
const b = await wv.research('MCP session id header removed 2026', { sessionId: 'demo' });
console.log(a.stats.ingest, b.stats.ingest); // b shows cached pages
console.log(await wv.listSessions());

// 2) A custom search provider (e.g. your own index) — implements SearchProvider.
const mine = customSearchProvider('my-index', async (_query) => [
  {
    url: 'https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http',
    title: 'MCP transports',
    rank: 1,
  },
]);
const wv2 = new WebVector({ search: { instance: mine, fallbackProviders: [] } });
const c = await wv2.research('what is the MCP endpoint', { topK: 3 });
console.log(c.passages.map((p) => p.citation));
await wv.close();
await wv2.close();
