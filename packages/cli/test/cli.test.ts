/**
 * Smoke tests for the built CLI (`npm run build` first; skipped when dist/ is missing). Runs the
 * offline commands only (cache, doctor --json, init --yes) against a throwaway XDG directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCacheDb } from '../../core/src/cache/db.js';
import { probeRuntime } from '../../core/src/runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, '../dist/cli.js');
const caps = await probeRuntime();
const d = existsSync(CLI) && caps.sqlite ? describe : describe.skip;

let xdg: string;
let cwd: string;
const env = () => ({
  ...process.env,
  XDG_CACHE_HOME: join(xdg, 'cache'),
  XDG_DATA_HOME: join(xdg, 'data'),
  WEBVECTOR_EMBEDDINGS_PROVIDER: 'none',
  NO_COLOR: '1',
});
const run = (args: string[], opts: { cwd?: string; input?: string } = {}) =>
  execFileSync(process.execPath, [CLI, ...args], {
    env: env(),
    cwd: opts.cwd ?? cwd,
    input: opts.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

beforeAll(() => {
  xdg = mkdtempSync(join(tmpdir(), 'wv-cli-xdg-'));
  cwd = mkdtempSync(join(tmpdir(), 'wv-cli-cwd-'));
});
afterAll(() => {
  rmSync(xdg, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

d('webvector CLI (built)', () => {
  it('cache stats/ls/prune/clear work on an empty and a populated cache', async () => {
    expect(run(['cache', 'stats', '--no-config'])).toMatch(/not created yet/);
    // Populate the cache directly (no network in unit tests).
    const dir = join(xdg, 'cache', 'webvector');
    const db = (await openCacheDb({ dir }))!;
    const now = Date.now();
    for (const [i, age] of [0, 10 * 86_400_000].entries()) {
      db.putPage({
        url_key: `k${i}`,
        url: `https://h${i}.example/p`,
        final_url: `https://h${i}.example/p`,
        fetched_at: now - age,
        last_access: now - age,
        etag: i ? null : '"e"',
        last_modified: null,
        max_age_ms: null,
        content_type: 'text/html',
        title: `t${i}`,
        markdown: 'hello',
        bytes: 5,
        md_bytes: 5,
        page_hash: 'h',
        meta: '{}',
      });
    }
    db.putEmbeddings([
      { model: 'm', dims: 2, dtype: 'fp32', role: 'document', hash: 'x', vec: new Float32Array(2) },
    ]);
    db.close();
    const stats = JSON.parse(run(['cache', 'stats', '--json', '--no-config']));
    expect(stats.pages.count).toBe(2);
    expect(stats.embeddings.count).toBe(1);
    expect(stats.hosts).toHaveLength(2);
    const ls = run(['cache', 'ls', '--no-config']);
    expect(ls).toContain('https://h0.example/p');
    expect(ls).toContain('https://h1.example/p');
    expect(run(['cache', 'prune', '--older-than', '7d', '--no-config'])).toMatch(/pruned 1 page/);
    expect(JSON.parse(run(['cache', 'stats', '--json', '--no-config'])).pages.count).toBe(1);
    expect(run(['cache', 'clear', '--no-config'])).toMatch(/removed 1 page\(s\) and 1 embedding/);
    expect(JSON.parse(run(['cache', 'stats', '--json', '--no-config'])).pages.count).toBe(0);
  });

  it('doctor --json reports runtime, cache and store checks', () => {
    const out = JSON.parse(run(['doctor', '--json', '--no-config']));
    expect(out.ok).toBe(true);
    const checks = out.checks.map((c: { check: string }) => c.check);
    expect(checks).toContain('runtime');
    expect(checks).toContain('cache');
    const runtime = out.checks.find((c: { check: string }) => c.check === 'runtime');
    expect(runtime.message).toMatch(/node:sqlite available/);
  });

  it('search --max-age rejects garbage durations', () => {
    expect(() =>
      run(['fetch', 'https://example.com/', '--max-age', 'soon', '--no-config']),
    ).toThrow(/Invalid duration/);
  });
});
