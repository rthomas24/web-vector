import { afterEach, describe, expect, it } from 'vitest';
import { WebVector } from 'webvector';
import {
  buildInstructions,
  createWebVectorMcpServer,
  MAX_INSTRUCTIONS_BYTES,
} from '../src/index.js';
import { connect, type RpcClient } from './helpers.js';

let client: RpcClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

const NOW_ISO = new Date().toUTCString();
const YAHOO = `<?xml version="1.0"?><rss version="2.0"><channel><title>Yahoo! Finance: AAPL News</title><item><title>Apple Reports Record Quarter</title><link>https://finance.yahoo.com/news/aapl-record.html</link><pubDate>${NOW_ISO}</pubDate><description>Apple Inc. (NASDAQ:AAPL) beat estimates.</description></item></channel></rss>`;
const EMPTY = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>';
const TICKERS = JSON.stringify({
  fields: ['cik', 'name', 'ticker', 'exchange'],
  data: [[320193, 'Apple Inc.', 'AAPL', 'Nasdaq']],
});

function marketsFetch(): typeof fetch {
  return async (input: any) => {
    const url = typeof input === 'string' ? input : (input.url ?? String(input));
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    if (/feeds\.finance\.yahoo\.com/.test(url))
      return new Response(YAHOO, { headers: { 'content-type': 'application/xml' } });
    if (/company_tickers_exchange\.json/.test(url))
      return new Response(TICKERS, { headers: { 'content-type': 'application/json' } });
    if (/\.xml$|rss|feed|format=rss/.test(url))
      return new Response(EMPTY, { headers: { 'content-type': 'application/xml' } });
    return new Response('not found', { status: 404 });
  };
}

function wv(): WebVector {
  return new WebVector(
    {
      search: { fallbackProviders: [] },
      embeddings: { provider: 'none' },
      ingestion: {
        respectRobotsTxt: false,
        perHostMinIntervalMs: 0,
        retries: 0,
        timeoutMs: 1500,
        allowPrivateNetworks: true,
        cache: { enabled: false },
      },
      markets: { deadlineMs: 4000 },
      logging: { level: 'silent' },
      fetch: marketsFetch(),
    },
    { env: {} },
  );
}

describe('markets tools (opt-in)', () => {
  it('are absent from the default tools/list', async () => {
    client = await connect(createWebVectorMcpServer({ webvector: wv() }));
    const list = await client.call('tools/list');
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).not.toContain('webvector_news');
    expect(names).toHaveLength(5);
  });

  it('`markets` expands to the five tools after the core tools; descriptions stay < 2 KB', async () => {
    client = await connect(
      createWebVectorMcpServer({
        webvector: wv(),
        tools: ['webvector_research', 'webvector_markets'],
      }),
    );
    const list = await client.call('tools/list');
    expect(list.result.tools.map((t: any) => t.name)).toEqual([
      'webvector_research',
      'webvector_news',
      'webvector_filings',
      'webvector_calendar',
      'webvector_sentiment',
      'webvector_pulse',
    ]);
    for (const t of list.result.tools) expect(Buffer.byteLength(t.description)).toBeLessThan(2048);
    expect(client.init.instructions).toContain('webvector_news');
    expect(Buffer.byteLength(client.init.instructions)).toBeLessThanOrEqual(MAX_INSTRUCTIONS_BYTES);
  });

  it('instructions mention markets only when enabled and still fit', () => {
    const withMarkets = buildInstructions({ tier: 'lexical', tools: { markets: true } });
    const without = buildInstructions({ tier: 'lexical' });
    expect(withMarkets).toContain('webvector_filings');
    expect(without).not.toContain('webvector_filings');
    expect(Buffer.byteLength(withMarkets)).toBeLessThanOrEqual(MAX_INSTRUCTIONS_BYTES);
    expect(withMarkets).toContain('Budget:'); // nothing was truncated away
  });

  it('webvector_news returns compact markdown + structuredContent', async () => {
    client = await connect(
      createWebVectorMcpServer({ webvector: wv(), tools: ['webvector_news'] }),
    );
    const r = await client.call('tools/call', {
      name: 'webvector_news',
      arguments: { symbols: ['AAPL'], hours: 6, limit: 5 },
    });
    expect(r.result.isError).toBeUndefined();
    const text: string = r.result.content[0].text;
    expect(text).toContain('## News — AAPL');
    expect(text).toContain('Apple Reports Record Quarter');
    expect(text).toContain('[earnings]');
    expect(text).toContain('Sources:');
    expect(r.result.structuredContent.items[0].tickers).toContain('AAPL');
  });

  it('webvector_filings rejects calls without symbol/cik/query in-band', async () => {
    client = await connect(
      createWebVectorMcpServer({ webvector: wv(), tools: ['webvector_markets'] }),
    );
    const r = await client.call('tools/call', { name: 'webvector_filings', arguments: {} });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('MISSING_ARGUMENT');
  });

  it('respects --max-uses like the core tools', async () => {
    client = await connect(
      createWebVectorMcpServer({
        webvector: wv(),
        tools: ['webvector_news'],
        guardOptions: { maxUses: 1 },
      }),
    );
    const ok = await client.call('tools/call', {
      name: 'webvector_news',
      arguments: { symbols: ['AAPL'] },
    });
    expect(ok.result.isError).toBeUndefined();
    const no = await client.call('tools/call', {
      name: 'webvector_news',
      arguments: { symbols: ['AAPL'] },
    });
    expect(no.result.isError).toBe(true);
    expect(no.result.content[0].text).toMatch(/MAX_USES/);
  });
});
