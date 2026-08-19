import { describe, expect, it } from 'vitest';
import { redactSecrets, WebVectorError } from '../src/errors.js';
import { createLimiter, KeyedQueue, retry, settleWithDeadline } from '../src/util/concurrency.js';
import { contentHash, sha256, uuidFromString } from '../src/util/hash.js';
import { LRU } from '../src/util/lru.js';
import {
  canonicalizeUrl,
  looksBinary,
  matchesDomain,
  normalizeUrl,
  registrableDomain,
} from '../src/util/url.js';
import {
  combine,
  cosine,
  decodeBase64Float32,
  l2Normalize,
  truncateDims,
} from '../src/util/vector.js';

describe('url utils', () => {
  it('canonicalises tracking params, www, fragments, trailing slashes', () => {
    expect(canonicalizeUrl('https://www.Example.com/a/b/?utm_source=x&b=2&a=1#frag')).toBe(
      'https://example.com/a/b?a=1&b=2',
    );
    expect(canonicalizeUrl('http://example.com:80/')).toBe('http://example.com/');
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });
  it('normalises only http(s)', () => {
    expect(normalizeUrl('ftp://x/y')).toBeNull();
    expect(normalizeUrl('https://a.com/x#y')).toBe('https://a.com/x');
  });
  it('registrable domain', () => {
    expect(registrableDomain('a.b.example.com')).toBe('example.com');
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('localhost')).toBe('localhost');
  });
  it('matchesDomain suffix semantics', () => {
    expect(matchesDomain('docs.python.org', ['python.org'])).toBe(true);
    expect(matchesDomain('docs.python.org', ['*.python.org'])).toBe(true);
    expect(matchesDomain('notpython.org', ['python.org'])).toBe(false);
    expect(matchesDomain('x.com', undefined)).toBe(false);
  });
  it('looksBinary', () => {
    expect(looksBinary('https://a.com/x.png')).toBe(true);
    expect(looksBinary('https://a.com/x.pdf')).toBe(false);
  });
});

describe('hash', () => {
  it('sha256 is stable and short', () => {
    expect(sha256('abc')).toHaveLength(22);
    expect(sha256('abc')).toBe(sha256('abc'));
  });
  it('contentHash ignores whitespace/case', () => {
    expect(contentHash('Hello   World')).toBe(contentHash('hello world'));
  });
  it('uuidFromString is a valid uuid', () => {
    expect(uuidFromString('x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('vector', () => {
  it('normalises and computes cosine', () => {
    const v = l2Normalize(new Float32Array([3, 4]));
    expect(v[0]).toBeCloseTo(0.6);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });
  it('combine + truncate', () => {
    const c = combine([
      { v: new Float32Array([1, 0]), w: 1 },
      { v: new Float32Array([0, 1]), w: 1 },
    ]);
    expect(c[0]).toBeCloseTo(Math.SQRT1_2);
    expect(truncateDims(new Float32Array([3, 4, 100]), 2)[0]).toBeCloseTo(0.6);
  });
  it('decodes base64 float32', () => {
    const buf = Buffer.alloc(8);
    buf.writeFloatLE(1.5, 0);
    buf.writeFloatLE(-2, 4);
    const v = decodeBase64Float32(buf.toString('base64'));
    expect([...v]).toEqual([1.5, -2]);
  });
});

describe('LRU', () => {
  it('evicts by size and ttl', async () => {
    const evicted: string[] = [];
    const lru = new LRU<string, number>(2, 30, (k) => evicted.push(k));
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.get('a')).toBeUndefined();
    expect(evicted).toEqual(['a']);
    await new Promise((r) => setTimeout(r, 40));
    expect(lru.get('b')).toBeUndefined();
  });
});

describe('concurrency', () => {
  it('limiter caps concurrency', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limit(async () => {
          active++;
          max = Math.max(max, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(max).toBe(2);
  });
  it('keyed queue enforces min interval per key', async () => {
    const q = new KeyedQueue({ concurrency: 1, minIntervalMs: 30 });
    const starts: number[] = [];
    await Promise.all([
      q.run('h', async () => void starts.push(Date.now())),
      q.run('h', async () => void starts.push(Date.now())),
    ]);
    expect((starts[1] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(25);
  });
  it('retry retries retryable errors and gives up', async () => {
    let n = 0;
    await expect(
      retry(
        async () => {
          n++;
          throw new WebVectorError('x', { code: 'PROVIDER_ERROR', retryable: true });
        },
        {
          retries: 2,
          minDelayMs: 1,
          jitter: false,
          shouldRetry: (e) => WebVectorError.is(e) && e.retryable,
        },
      ),
    ).rejects.toThrow();
    expect(n).toBe(3);
  });
  it('settleWithDeadline marks stragglers', async () => {
    const res = await settleWithDeadline(
      [Promise.resolve(1), new Promise<number>((r) => setTimeout(() => r(2), 200))],
      20,
      () => -1,
    );
    expect(res).toEqual([1, -1]);
  });
});

describe('errors', () => {
  it('redacts secrets and serialises', () => {
    const e = new WebVectorError('key sk-abcdefghijklmnop leaked', {
      code: 'PROVIDER_AUTH',
      remediation: 'fix',
      provider: 'openai',
    });
    expect(e.message).not.toContain('sk-abcdefghijklmnop');
    expect(e.toJSON()).toMatchObject({
      code: 'PROVIDER_AUTH',
      provider: 'openai',
      remediation: 'fix',
    });
    expect(e.describe()).toContain('→ fix');
    expect(redactSecrets('Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });
  it('wraps unknown errors', () => {
    const e = WebVectorError.from(new Error('boom'), { code: 'FETCH_FAILED' });
    expect(e.code).toBe('FETCH_FAILED');
    const t = new Error('t');
    t.name = 'TimeoutError';
    expect(WebVectorError.from(t, { code: 'FETCH_FAILED' }).code).toBe('FETCH_TIMEOUT');
  });
});

describe('secret redaction (extended)', () => {
  it('redacts URL userinfo, query keys and nested error details', () => {
    expect(redactSecrets('see https://user:hunter2@qdrant.local:6333/x')).toBe(
      'see https://user:***@qdrant.local:6333/x',
    );
    expect(redactSecrets('GET https://api.x/search?q=a&api_key=abcdef123&x=1')).toBe(
      'GET https://api.x/search?q=a&api_key=***&x=1',
    );
    const e = new WebVectorError('boom', {
      code: 'PROVIDER_ERROR',
      details: { body: 'token sk-abcdefghijklmnop leaked', nested: ['key=zzzzzz'] },
    });
    const j = JSON.stringify(e.toJSON());
    expect(j).not.toContain('sk-abcdefghijklmnop');
  });
});
