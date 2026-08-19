import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type HttpFixture, recordingFetch } from '../src/testing/recording-fetch.js';

const fakeFetch = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init,
    )) as typeof fetch;

describe('recordingFetch', () => {
  it('records then replays without touching the network', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-rec-'));
    let calls = 0;
    const net = fakeFetch(
      () =>
        new Response('<html><body>hi</body></html>', {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            etag: '"abc"',
            'set-cookie': 'sid=secret',
            authorization: 'Bearer nope',
          },
        }),
    );
    const rec = recordingFetch({
      dir,
      mode: 'record',
      fetch: (async (i, init) => {
        calls++;
        return net(i, init);
      }) as typeof fetch,
    });
    const r1 = await rec('https://example.com/a?b=1');
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain('hi');
    expect(rec.stats.recorded).toBe(1);

    const path = rec.fixturePath('https://example.com/a?b=1');
    expect(existsSync(path)).toBe(true);
    const fx = JSON.parse(readFileSync(path, 'utf8')) as HttpFixture;
    expect(fx.headers.etag).toBe('"abc"');
    expect(fx.headers['set-cookie']).toBeUndefined();
    expect(fx.headers.authorization).toBeUndefined();
    expect(fx.bodyEncoding).toBe('utf8');

    const replay = recordingFetch({ dir, mode: 'replay', fetch: net });
    const r2 = await replay('https://example.com/a?b=1');
    expect(r2.headers.get('etag')).toBe('"abc"');
    expect(await r2.text()).toContain('hi');
    expect(replay.stats.hits).toBe(1);
    expect(calls).toBe(1); // only the recording call hit the fake network
  });

  it('replay mode throws a helpful error on a missing fixture; auto mode records instead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-rec-'));
    const net = fakeFetch(() => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    const replay = recordingFetch({ dir, mode: 'replay', fetch: net });
    await expect(replay('https://example.com/missing')).rejects.toThrow(/no fixture/);
    const auto = recordingFetch({ dir, mode: 'auto', fetch: net });
    expect(await (await auto('https://example.com/missing')).text()).toBe('ok');
    expect(auto.stats.misses).toBe(1);
    expect(auto.stats.recorded).toBe(1);
    expect(await (await auto('https://example.com/missing')).text()).toBe('ok');
    expect(auto.stats.hits).toBe(1);
  });

  it('handles null-body statuses and binary bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-rec-'));
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x01]);
    const net = fakeFetch((url) =>
      url.endsWith('/304')
        ? new Response(null, { status: 304, headers: { etag: '"x"' } })
        : new Response(bytes, { headers: { 'content-type': 'application/pdf' } }),
    );
    const rec = recordingFetch({ dir, mode: 'record', fetch: net });
    expect((await rec('https://example.com/304')).status).toBe(304);
    const pdf = await rec('https://example.com/file.pdf');
    expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(bytes);
    const fx = JSON.parse(readFileSync(rec.fixturePath('https://example.com/file.pdf'), 'utf8'));
    expect(fx.bodyEncoding).toBe('base64');

    const replay = recordingFetch({ dir, mode: 'replay', fetch: net });
    expect((await replay('https://example.com/304')).status).toBe(304);
    expect(
      new Uint8Array(await (await replay('https://example.com/file.pdf')).arrayBuffer()),
    ).toEqual(bytes);
  });

  it('keys non-GET requests by body and honours abort in replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-rec-'));
    const net = fakeFetch(async (_u, init) => new Response(`echo:${init?.body}`));
    const rec = recordingFetch({ dir, mode: 'auto', fetch: net });
    expect(await (await rec('https://api.example/x', { method: 'POST', body: 'a' })).text()).toBe(
      'echo:a',
    );
    expect(await (await rec('https://api.example/x', { method: 'POST', body: 'b' })).text()).toBe(
      'echo:b',
    );
    expect(rec.stats.recorded).toBe(2);
    const ac = new AbortController();
    ac.abort();
    await expect(
      rec('https://api.example/x', { method: 'POST', body: 'a', signal: ac.signal }),
    ).rejects.toThrow(/aborted/);
  });
});

describe('recordingFetch options', () => {
  it('compresses and transforms text bodies at record time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-rec-'));
    const html = `<html><head><script>var x = 1;</script></head><body>${'text '.repeat(200)}</body></html>`;
    const net = fakeFetch(() => new Response(html, { headers: { 'content-type': 'text/html' } }));
    const rec = recordingFetch({
      dir,
      mode: 'record',
      fetch: net,
      compress: true,
      transformBody: (b) => b.replace(/<script>[\s\S]*?<\/script>/, ''),
    });
    const body = await (await rec('https://example.com/big')).text();
    expect(body).not.toContain('var x');
    const fx = JSON.parse(readFileSync(rec.fixturePath('https://example.com/big'), 'utf8'));
    expect(fx.bodyEncoding).toBe('gzip-base64');
    expect(fx.body.length).toBeLessThan(html.length / 3);
    const replay = recordingFetch({ dir, mode: 'replay', fetch: net });
    expect(await (await replay('https://example.com/big')).text()).toBe(body);
  });
});
