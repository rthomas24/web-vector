/**
 * In-process MCP test harness: connects a McpServer to one side of an InMemoryTransport pair and
 * speaks raw JSON-RPC on the other side (no client package needed).
 */
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { WebVector, type WebVectorConfig } from 'webvector';
import { customSearchProvider } from 'webvector/search';

export interface RpcClient {
  call(method: string, params?: unknown, meta?: Record<string, unknown>): Promise<any>;
  notifications: any[];
  /** `initialize` result (serverInfo, instructions, capabilities). */
  init: any;
  close(): Promise<void>;
}

/** Initialize (2025-era handshake) and return a JSON-RPC caller. */
export async function connect(server: McpServer): Promise<RpcClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (m: any) => void>();
  const notifications: any[] = [];
  let id = 0;
  clientSide.onmessage = (msg: any) => {
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    } else if (msg.method) notifications.push(msg);
  };
  await clientSide.start();
  await server.connect(serverSide);
  const call = (method: string, params: unknown = {}, meta?: Record<string, unknown>) =>
    new Promise<any>((resolve) => {
      const m = {
        jsonrpc: '2.0',
        id: ++id,
        method,
        params: meta ? { ...(params as object), _meta: meta } : params,
      };
      pending.set(m.id, resolve);
      void clientSide.send(m as any);
    });
  const init = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} } as any);
  return {
    call,
    notifications,
    init: init.result,
    close: async () => {
      await server.close();
      await clientSide.close();
    },
  };
}

const filler =
  'Additional filler sentence to make the paragraph long enough for extraction and chunking. ';
export const page = (title: string, paras: string[]) =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${paras
    .map((p) => `<p>${p} ${filler.repeat(6)}</p>`)
    .join('')}</article></body></html>`;

/** Fake site: URL → HTML (or a status code). */
export const SITES: Record<string, string | number> = {
  'https://rrf.example/intro': page('RRF intro', [
    'Reciprocal rank fusion combines ranked lists. The rank of each document matters.',
    'The formula for rank fusion uses 1/(k+rank).',
    'Fusion works across systems and rank lists.',
    'Rank fusion history and rank fusion variants such as weighted rank fusion.',
    'Reciprocal rank fusion parameter k is usually 60 in rank fusion.',
    'Rank fusion in hybrid search combines BM25 rank and vector rank.',
    'See also <a href="https://rrf.example/paper">the paper</a> and <a href="https://other.example/x">other</a>.',
  ]),
  'https://fruit.example/banana': page('Bananas', [
    'Banana banana banana is a fruit.',
    'Weather affects banana crops.',
  ]),
  'https://py.example/doc': page('Python docs', [
    'Python is a programming language.',
    'The formula module in python computes things.',
  ]),
  'https://down.example/x': 500,
};

export function fakeFetch(sites: Record<string, string | number> = SITES): typeof fetch {
  return async (input: any) => {
    const url = typeof input === 'string' ? input : (input.url ?? String(input));
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    const hit = sites[url];
    if (hit === undefined) return new Response('not found', { status: 404 });
    if (typeof hit === 'number') return new Response('nope', { status: hit });
    return new Response(hit, { status: 200, headers: { 'content-type': 'text/html' } });
  };
}

export const mockSearch = customSearchProvider('mock', async (q) => {
  if (/nothing/i.test(q)) return [];
  return [
    {
      url: 'https://rrf.example/intro',
      title: 'RRF intro',
      snippet: 'Reciprocal rank fusion combines ranked lists',
      rank: 1,
    },
    { url: 'https://fruit.example/banana', title: 'Bananas', snippet: 'Banana fruit', rank: 2 },
    { url: 'https://py.example/doc', title: 'Python docs', snippet: 'python', rank: 3 },
    { url: 'https://down.example/x', title: 'Down', snippet: 'x', rank: 4 },
  ];
});

/** Lexical-tier WebVector wired to the fake site (fully offline). */
export function makeWebVector(extra: WebVectorConfig = {}): WebVector {
  return new WebVector(
    {
      search: { instance: mockSearch, fallbackProviders: [] },
      embeddings: { provider: 'none' },
      ingestion: {
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        timeoutMs: 1500,
        totalDeadlineMs: 5000,
        minChunkChars: 20,
        chunkSize: 80,
        allowPrivateNetworks: true,
      },
      retrieval: { maxPerSource: 3, relativeCutoff: 0, lexicalRelativeCutoff: 0, mmr: false },
      logging: { level: 'silent' },
      fetch: fakeFetch(),
      ...extra,
    },
    { env: {} },
  );
}
