/** Errors that teach, depth preset, sessions, guardrails, progress/deadline, prompts. */

import { afterEach, describe, expect, it } from 'vitest';
import { ToolGuard } from 'webvector';
import { createWebVectorMcpServer, processSessionId, progressMessage } from '../src/index.js';
import { researchPromptText, verifyClaimPromptText } from '../src/prompts.js';
import { hintFor, validateDomains } from '../src/results.js';
import { connect, makeWebVector, type RpcClient } from './helpers.js';

let client: RpcClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

const call = (name: string, args: Record<string, unknown>) =>
  client!.call('tools/call', { name, arguments: args });

describe('errors that teach', () => {
  it('zero passages is not an error and says what to try next', async () => {
    client = await connect(createWebVectorMcpServer({ webvector: makeWebVector() }));
    const r = await call('webvector_research', { query: 'nothing at all here' });
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content[0].text).toContain(
      '_No relevant passages. Try: drop freshness, remove domain filters, 2–3 related_queries with synonyms, or webvector_search to inspect the SERP._',
    );
    expect(r.result.structuredContent.hint).toMatch(/^No relevant passages/);
    expect(r.result.structuredContent.retryable).toBe(true);
    expect(r.result.structuredContent.passages).toEqual([]);
  });
  it('invalid domain filters show the correct form; URL-shaped ones are auto-corrected', async () => {
    client = await connect(createWebVectorMcpServer({ webvector: makeWebVector() }));
    const bad = await call('webvector_research', {
      query: 'rank fusion',
      domains_allow: ['not a domain'],
    });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('bare domains like "docs.python.org"');
    expect(bad.result.structuredContent.hint).toMatch(/Retry with domains_allow/);
    expect(validateDomains('domains_allow', ['https://docs.python.org/3/library/'])).toEqual({
      ok: true,
      domains: ['docs.python.org'],
    });
    expect(validateDomains('x', ['*.example.org', 'Sub.Example.com'])).toEqual({
      ok: true,
      domains: ['example.org', 'sub.example.com'],
    });
    const ok = await call('webvector_search', {
      query: 'rank fusion',
      domains_allow: ['https://rrf.example/x'],
    });
    expect(ok.result.isError).toBeUndefined();
    expect(ok.result.content[0].text).toContain('rrf.example');
    expect(ok.result.content[0].text).toContain('→ To read a result: webvector_fetch(url)');
  });
  it('unsupported freshness adds a warning line; thrown errors carry hint + retryable', async () => {
    client = await connect(createWebVectorMcpServer({ webvector: makeWebVector() }));
    const r = await call('webvector_search', { query: 'rank fusion', freshness: 'week' });
    expect(r.result.content[0].text).toContain('ignores freshness');
    const e = await call('webvector_fetch', { url: 'https://down.example/x' });
    expect(e.result.isError).toBe(true);
    expect(e.result.content[0].text).toMatch(
      /Error \(FETCH_HTTP_ERROR\)[\s\S]*→ The page could not be fetched/,
    );
    expect(e.result.structuredContent.retryable).toBe(true);
    const { WebVectorError } = await import('webvector');
    const rl = hintFor(
      new WebVectorError('429', {
        code: 'PROVIDER_RATE_LIMITED',
        retryAfterMs: 4000,
        retryable: true,
      }),
    );
    expect(rl.hint).toMatch(/^Retry in 4s/);
    expect(rl.hint).toContain('BRAVE_API_KEY');
    expect(rl.retryable).toBe(true);
  });
});

describe('depth preset + deadline + progress', () => {
  it('depth: fast lowers pages/topK; deadline_ms returns partial results with the reason', async () => {
    client = await connect(
      createWebVectorMcpServer({ webvector: makeWebVector(), structured: 'full' }),
    );
    const list = await client.call('tools/list');
    const research = list.result.tools.find((t: any) => t.name === 'webvector_research');
    expect(research.inputSchema.properties.depth.enum).toEqual(['fast', 'balanced', 'thorough']);
    for (const k of ['objective', 'category', 'deadline_ms'])
      expect(research.inputSchema.properties[k]).toBeDefined();
    const fast = await call('webvector_research', {
      query: 'rank fusion banana python',
      depth: 'fast',
    });
    expect(fast.result.structuredContent.stats.ingest.requested).toBeLessThanOrEqual(4);
    expect(fast.result.structuredContent.passages.length).toBeLessThanOrEqual(6);
    const wv = makeWebVector();
    await client.close();
    client = await connect(createWebVectorMcpServer({ webvector: wv, maxDeadlineMs: 5000 }));
    const p = await client.call(
      'tools/call',
      { name: 'webvector_research', arguments: { query: 'rank fusion', deadline_ms: 2000 } },
      { progressToken: 'p1' },
    );
    expect(p.result.isError).toBeUndefined();
    const progress = client.notifications.filter((n) => n.method === 'notifications/progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((n) => /^fetched \d+\/\d+ pages/.test(n.params.message))).toBe(true);
    expect(progress.some((n) => /\(1 failed\)/.test(n.params.message))).toBe(true);
    expect(progressMessage({ stage: 'ingest', done: 5, total: 8, failed: 2, message: '' })).toBe(
      'fetched 5/8 pages (2 failed) · embedding',
    );
    expect(progressMessage({ stage: 'ingest', done: 8, total: 8, message: '' })).toBe(
      'fetched 8/8 pages',
    );
  });
});

describe('server-minted sessions', () => {
  const sessionCount = async () =>
    (await call('webvector_status', {})).result.structuredContent.sessions.count as number;
  it('stdio: calls without session_id share one process-wide session (pages reused)', async () => {
    client = await connect(
      createWebVectorMcpServer({ webvector: makeWebVector(), structured: 'full' }),
    );
    const a = await call('webvector_research', { query: 'rank fusion formula' });
    expect(a.result.structuredContent.session_id).toBeUndefined(); // nothing to hand back on stdio
    expect(a.result.content[0].text).not.toContain('session_id:');
    await call('webvector_research', { query: 'rank fusion parameter k' });
    expect(await sessionCount()).toBe(1);
    expect(processSessionId()).toMatch(/^wv_/);
  });
  it('http: mints an opaque session_id per call, returned in text + structured and accepted back', async () => {
    client = await connect(
      createWebVectorMcpServer({
        webvector: makeWebVector(),
        transport: 'http',
        structured: 'full',
      }),
    );
    const a = await call('webvector_research', { query: 'rank fusion formula' });
    const sid: string = a.result.structuredContent.session_id;
    expect(sid).toMatch(/^wv_[A-Za-z0-9_-]{8}$/);
    expect(a.result.content[0].text).toContain(
      `_session_id: ${sid} — pass it back to reuse these pages._`,
    );
    const b = await call('webvector_research', {
      query: 'rank fusion parameter k',
      session_id: sid,
    });
    expect(b.result.structuredContent.session_id).toBeUndefined(); // client-supplied ids are not echoed
    expect(await sessionCount()).toBe(1); // reused
    const c = await call('webvector_research', { query: 'rank fusion parameter k' });
    expect(c.result.structuredContent.session_id).not.toBe(sid);
    expect(await sessionCount()).toBe(2); // fresh session minted
  });
  it('--session-mode off: no minting', async () => {
    client = await connect(
      createWebVectorMcpServer({
        webvector: makeWebVector(),
        sessionMode: 'off',
        structured: 'full',
      }),
    );
    await call('webvector_research', { query: 'rank fusion formula' });
    await call('webvector_research', { query: 'rank fusion parameter k' });
    expect(await sessionCount()).toBe(0);
  });
});

describe('guardrails', () => {
  it('--max-uses → in-band MAX_USES_EXCEEDED after the budget', async () => {
    client = await connect(
      createWebVectorMcpServer({ webvector: makeWebVector(), guardOptions: { maxUses: 2 } }),
    );
    expect((await call('webvector_search', { query: 'a' })).result.isError).toBeUndefined();
    expect(
      (await call('webvector_fetch', { url: 'https://rrf.example/intro' })).result.isError,
    ).toBeUndefined();
    const r = await call('webvector_research', { query: 'rank fusion' });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('Error (MAX_USES_EXCEEDED)');
    expect(r.result.structuredContent.error.code).toBe('MAX_USES_EXCEEDED');
    expect(r.result.structuredContent.retryable).toBe(false);
    const status = await call('webvector_status', {});
    expect(status.result.structuredContent.server).toMatchObject({ uses: 2, remainingUses: 0 });
  });
  it('--allowed-domains / --blocked-domains apply to search, research and fetch', async () => {
    client = await connect(
      createWebVectorMcpServer({
        webvector: makeWebVector(),
        structured: 'full',
        guardOptions: {
          allowedDomains: ['rrf.example', 'py.example'],
          blockedDomains: ['py.example'],
        },
      }),
    );
    const s = await call('webvector_search', { query: 'rank fusion' });
    expect(s.result.structuredContent.results.map((r: any) => r.url)).toEqual([
      'https://rrf.example/intro',
    ]);
    const r = await call('webvector_research', { query: 'rank fusion banana' });
    expect(r.result.structuredContent.sources.map((x: any) => x.url)).toEqual([
      'https://rrf.example/intro',
    ]);
    const f = await call('webvector_fetch', { url: 'https://fruit.example/banana' });
    expect(f.result.isError).toBe(true);
    expect(f.result.content[0].text).toContain('DOMAIN_NOT_ALLOWED');
    expect(f.result.content[0].text).toContain('Allowed domains: rrf.example, py.example');
    // caller asking for a disallowed domain gets nothing rather than a bypass
    const none = await call('webvector_search', {
      query: 'rank fusion',
      domains_allow: ['fruit.example'],
    });
    expect(none.result.structuredContent.results).toEqual([]);
  });
  it('ToolGuard user location passthrough + parse', async () => {
    const { parseUserLocation } = await import('webvector');
    expect(parseUserLocation('US')).toEqual({ country: 'US' });
    expect(parseUserLocation('us,en-GB')).toEqual({ country: 'US', language: 'en-GB' });
    expect(parseUserLocation('country=DE;language=de')).toEqual({ country: 'DE', language: 'de' });
    expect(parseUserLocation('')).toBeUndefined();
    const g = new ToolGuard({ userLocation: { country: 'US', language: 'en' } });
    expect(g.searchLocation()).toEqual({ country: 'US', language: 'en' });
  });
});

describe('prompts', () => {
  it('lists research + verify_claim and renders a research loop', async () => {
    client = await connect(createWebVectorMcpServer({ webvector: makeWebVector() }));
    const list = await client.call('prompts/list');
    expect(list.result.prompts.map((p: any) => p.name)).toEqual(['research', 'verify_claim']);
    const got = await client.call('prompts/get', {
      name: 'research',
      arguments: { topic: 'RRF k value', focus: 'defaults' },
    });
    const text: string = got.result.messages[0].content.text;
    expect(text).toContain('Research this on the live web and answer with citations: RRF k value');
    expect(text).toContain('Focus on: defaults');
    expect(text).toContain('webvector_research once');
    expect(text).toContain('Cite each claim inline as [n]');
    expect(researchPromptText('t')).not.toContain('Focus on');
    expect(verifyClaimPromptText('X is Y')).toContain(
      'Supported / Refuted / Partly true / Unverifiable',
    );
    const v = await client.call('prompts/get', {
      name: 'verify_claim',
      arguments: { claim: 'Node 24 removed X' },
    });
    expect(v.result.messages[0].content.text).toContain(
      'Verify this claim against the live web: "Node 24 removed X"',
    );
    // no prompts when the research tool is not exposed
    await client.close();
    client = await connect(
      createWebVectorMcpServer({ webvector: makeWebVector(), tools: ['webvector_fetch'] }),
    );
    const none = await client.call('prompts/list');
    expect(none.result?.prompts ?? []).toEqual([]);
  });
});

describe('webvector_verify', () => {
  it('checks [n] citations against the session passages (stdio default session) and explicit passages', async () => {
    client = await connect(
      createWebVectorMcpServer({ webvector: makeWebVector(), structured: 'full' }),
    );
    const list = await client!.call('tools/list', {});
    expect(list.result.tools.map((t: any) => t.name)).toContain('webvector_verify');
    const r = await call('webvector_research', { query: 'reciprocal rank fusion formula' });
    const passages = r.result.structuredContent.passages as { index: number; text: string }[];
    const known = 'Reciprocal rank fusion combines ranked lists';
    const cited = passages.find((p) => p.text.includes(known));
    expect(cited).toBeDefined();
    const v = await call('webvector_verify', {
      answer: `${known} [${cited!.index}]. Bananas cure headaches [${cited!.index}].`,
    });
    expect(v.result.isError).toBeFalsy();
    const sc = v.result.structuredContent;
    expect(sc.summary.total).toBe(2);
    expect(['verbatim', 'paraphrase']).toContain(sc.sentences[0].status);
    expect(sc.sentences[1].status).toBe('unsupported');
    expect(v.result.content[0].text).toMatch(/Support rate \d+%/);
    // Explicit passages instead of a session
    const v2 = await call('webvector_verify', {
      answer: `${known} [7].`,
      passages: [{ index: 7, url: 'https://rrf.example/intro', text: cited!.text }],
    });
    expect(v2.result.structuredContent.sentences[0].status).not.toBe('unsupported');
  });
  it('research accepts auto_retry / cache args and returns evidence + coverage in structured output', async () => {
    client = await connect(
      createWebVectorMcpServer({ webvector: makeWebVector(), structured: 'slim' }),
    );
    const r = await call('webvector_research', {
      query: 'rank fusion formula',
      related_queries: ['rank fusion parameter k'],
      auto_retry: 0,
      max_age_ms: 60_000,
      cache_mode: 'default',
    });
    expect(r.result.isError).toBeFalsy();
    const sc = r.result.structuredContent;
    expect(sc.evidence?.level).toBeDefined();
    expect(sc.coverage).toBeDefined();
  });
});
