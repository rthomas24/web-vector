/** Live MCP round-trip over stdio (spawns the built bin). Run with `npm run test:live` after `npm run build`. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const live = process.env.WEBVECTOR_LIVE === '1';
const bin = join(import.meta.dirname, '..', 'dist', 'bin.js');
const d = live && existsSync(bin) ? describe : describe.skip;

d('webvector-mcp stdio', () => {
  let proc: ReturnType<typeof spawn>;
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  const notifications: any[] = [];
  const send = (method: string, params: any) =>
    new Promise<any>((resolve) => {
      const m = { jsonrpc: '2.0', id: ++id, method, params };
      pending.set(m.id, resolve);
      proc.stdin!.write(`${JSON.stringify(m)}\n`);
    });
  beforeAll(() => {
    proc = spawn(process.execPath, [bin], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += d;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            pending.get(msg.id)!(msg);
            pending.delete(msg.id);
          } else if (msg.method) notifications.push(msg);
        }
        i = buf.indexOf('\n');
      }
    });
  });
  afterAll(() => proc.kill());

  it('initializes, lists tools, and runs webvector_research with progress + structuredContent', async () => {
    const init = await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(init.result.serverInfo.name).toBe('webvector');
    proc.stdin!.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    );
    const tools = await send('tools/list', {});
    expect(tools.result.tools.map((t: any) => t.name).sort()).toEqual([
      'webvector_fetch',
      'webvector_research',
      'webvector_search',
      'webvector_status',
      'webvector_verify',
    ]);
    const research = tools.result.tools.find((t: any) => t.name === 'webvector_research');
    expect(research.inputSchema.properties.query).toBeDefined();
    expect(research.annotations.readOnlyHint).toBe(true);
    const r = await send('tools/call', {
      name: 'webvector_research',
      arguments: { query: 'what is reciprocal rank fusion', top_k: 3, max_pages: 4 },
      _meta: { progressToken: 'p1' },
    });
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content[0].text).toContain('# Web research');
    expect(r.result.structuredContent.passages.length).toBeGreaterThan(0);
    expect(
      notifications.some(
        (n) => n.method === 'notifications/progress' && n.params.progressToken === 'p1',
      ),
    ).toBe(true);
    const bad = await send('tools/call', {
      name: 'webvector_fetch',
      arguments: { url: 'http://127.0.0.1:1/x' },
    });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('FETCH_BLOCKED_SSRF');
    const status = await send('tools/call', { name: 'webvector_status', arguments: {} });
    expect(status.result.structuredContent.config.search.provider).toBe('duckduckgo');
  }, 120_000);
});
