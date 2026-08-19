import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configFromEnv,
  interpolateEnv,
  loadConfig,
  mergeConfig,
  redactConfig,
  validateConfig,
} from '../src/config/index.js';
import { WebVectorError } from '../src/errors.js';

describe('config', () => {
  it('applies defaults', () => {
    const c = validateConfig({});
    expect(c.search.provider).toBe('duckduckgo');
    expect(c.embeddings.provider).toBe('auto');
    expect(c.retrieval.topK).toBe(12);
    expect(c.ingestion.maxPages).toBe(10);
  });
  it('rejects invalid values with remediation', () => {
    expect(() => validateConfig({ retrieval: { topK: 0 } })).toThrow(WebVectorError);
    try {
      validateConfig({ store: { mode: 'weird' as any } });
    } catch (e) {
      expect((e as WebVectorError).code).toBe('INVALID_CONFIG');
      expect((e as WebVectorError).message).toContain('store.mode');
    }
  });
  it('interpolates env vars', () => {
    const out = interpolateEnv(
      { a: '${FOO}', b: '${MISSING:-dflt}', c: ['${FOO}-x'] },
      { FOO: 'bar' },
    );
    expect(out).toEqual({ a: 'bar', b: 'dflt', c: ['bar-x'] });
  });
  it('reads WEBVECTOR_* env', () => {
    const c = configFromEnv({
      WEBVECTOR_SEARCH_PROVIDER: 'brave',
      WEBVECTOR_TOP_K: '5',
      WEBVECTOR_HYBRID: 'false',
      WEBVECTOR_SEARCH_FALLBACKS: 'wikipedia, tavily-keyless',
    });
    expect(c.search?.provider).toBe('brave');
    expect(c.retrieval?.topK).toBe(5);
    expect(c.retrieval?.hybrid).toBe(false);
    expect(c.search?.fallbackProviders).toEqual(['wikipedia', 'tavily-keyless']);
  });
  it('merges with precedence and replaces arrays', () => {
    const m = mergeConfig(
      { search: { provider: 'a', fallbackProviders: ['x'] } },
      { search: { fallbackProviders: ['y'] } },
      { search: { provider: 'c' } },
    );
    expect(m.search?.provider).toBe('c');
    expect(m.search?.fallbackProviders).toEqual(['y']);
  });
  it('loads a json config file with env interpolation and precedence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-'));
    writeFileSync(
      join(dir, 'webvector.config.json'),
      JSON.stringify({
        search: { provider: 'serper', apiKey: '${SERPER_TEST_KEY}' },
        retrieval: { topK: 7 },
      }),
    );
    const r = await loadConfig({
      cwd: dir,
      env: { SERPER_TEST_KEY: 'k123', WEBVECTOR_TOP_K: '3' },
      overrides: { retrieval: { mmr: false } },
    });
    expect(r.configPath).toBe(join(dir, 'webvector.config.json'));
    expect(r.file.search.provider).toBe('serper');
    expect(r.file.search.apiKey).toBe('k123');
    expect(r.file.retrieval.topK).toBe(7); // file beats env
    expect(r.file.retrieval.mmr).toBe(false); // overrides beat file
  });
  it('loads a yaml config file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-'));
    writeFileSync(
      join(dir, 'webvector.config.yaml'),
      'search:\n  provider: wikipedia\nembeddings:\n  provider: openai\n  model: text-embedding-3-large\n',
    );
    const r = await loadConfig({ cwd: dir, env: {} });
    expect(r.file.search.provider).toBe('wikipedia');
    expect(r.file.embeddings.model).toBe('text-embedding-3-large');
  });
  it('redacts secrets for printing', () => {
    const r = redactConfig({
      search: { apiKey: 'sk-verysecretkey' },
      store: { url: 'postgres://u:pw@h/db' },
    });
    expect(r.search.apiKey).not.toContain('verysecret');
    expect(r.store.url).toBe('postgres://u:***@h/db');
  });
});

describe('config hardening', () => {
  it('ignores prototype-polluting keys when merging and interpolating', () => {
    const evil = JSON.parse(
      '{"__proto__":{"polluted":true},"retrieval":{"topK":3,"constructor":{"x":1}}}',
    );
    const m = mergeConfig(evil) as any;
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.hasOwn(m, '__proto__')).toBe(false);
    expect(m.retrieval.constructor).toBe(Object); // not overwritten by config
    const i = interpolateEnv(evil, {}) as any;
    expect(Object.hasOwn(i, '__proto__')).toBe(false);
  });
  it('only discovers executable (js/ts) config in cwd, but data config up the tree', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { findConfigFile } = await import('../src/config/index.js');
    const root = mkdtempSync(join(tmpdir(), 'wv-cfg-'));
    const child = join(root, 'a', 'b');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, 'webvector.config.js'), 'export default {}');
    expect(findConfigFile(child)).toBeUndefined(); // js in a parent is NOT picked up
    expect(findConfigFile(root)).toBe(join(root, 'webvector.config.js')); // …but in cwd it is
    writeFileSync(join(root, 'webvector.config.json'), '{}');
    expect(findConfigFile(child)).toBe(join(root, 'webvector.config.json')); // data configs walk up
  });
  it('redacts a broad set of secret-looking keys and URL userinfo', () => {
    const r = redactConfig({
      a: { authorization: 'Bearer abcdefgh', cookie: 'sid=1234567', credential: 'xyz-secret' },
      store: { url: 'https://user:hunter2@qdrant.example:6333' },
      options: { 'x-api-key': 'k-1234567' },
    }) as any;
    expect(r.a.authorization).not.toContain('abcdefgh');
    expect(r.a.cookie).not.toContain('1234567');
    expect(r.a.credential).not.toContain('xyz-secret');
    expect(r.store.url).toBe('https://user:***@qdrant.example:6333');
    expect(r.options['x-api-key']).not.toContain('1234567');
  });
});
