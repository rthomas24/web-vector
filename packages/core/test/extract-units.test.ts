/** Unit tests for the extraction helper modules (ingest/extract-*.ts) and their wiring. */
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  detectJsShell,
  guessLangFromScript,
  normalizeLangTag,
} from '../src/ingest/extract-detect.js';
import { parseResource } from '../src/ingest/index.js';
import { HtmlParser } from '../src/ingest/parsers.js';

const shell = (body: string, head = '') =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

describe('detectJsShell', () => {
  const detect = (html: string) => {
    const { document } = parseHTML(html);
    for (const el of [...document.querySelectorAll('script,style,noscript,template')]) el.remove();
    return detectJsShell(html, document);
  };
  it('flags empty framework roots and names the framework', () => {
    const r = detect(
      shell(
        '<div id="root"></div><script src="/static/js/main.abc123.js"></script><noscript>You need to enable JavaScript to run this app.</noscript>',
      ),
    );
    expect(r.suspected).toBe(true);
    expect(r.signals).toContain('empty-root:#root');
    expect(r.signals).toContain('noscript:enable-javascript');
    expect(r.framework).toBe('react');
    expect(r.maxMarkdownLength).toBe(1500);
  });
  it('flags hydration markers alone with a low tolerance', () => {
    const r = detect(shell('<div><p>Hi</p></div><script>self.__next_f.push([1,"x"])</script>'));
    expect(r.suspected).toBe(true);
    expect(r.framework).toBe('next-app');
    expect(r.maxMarkdownLength).toBe(300);
  });
  it('does not flag server-rendered pages or plain login forms', () => {
    const ssr = detect(
      shell(
        `<div id="__next"><main><article>${'<p>Server rendered paragraph with plenty of words in it.</p>'.repeat(20)}</article></main></div><script id="__NEXT_DATA__" type="application/json">{}</script>`,
      ),
    );
    expect(ssr.signals).toContain('marker:next');
    expect(ssr.signals.some((s) => s.startsWith('empty-root'))).toBe(false);
    expect(ssr.maxMarkdownLength).toBe(300); // content is longer → not treated as a shell
    const login = detect(
      shell('<form><input name="u"><input name="p"><button>Sign in</button></form>'),
    );
    expect(login.suspected).toBe(false);
  });
});

describe('language helpers', () => {
  it('normalises tags', () => {
    expect(normalizeLangTag('EN_us')).toBe('en-US');
    expect(normalizeLangTag('de-DE, en;q=0.8')).toBe('de-DE');
    expect(normalizeLangTag('zh-Hant-TW')).toBe('zh-Hant-TW');
    expect(normalizeLangTag('')).toBeUndefined();
    expect(normalizeLangTag('12')).toBeUndefined();
  });
  it('guesses from script only when unambiguous', () => {
    expect(
      guessLangFromScript(
        'レート制限は、短時間に大量のリクエストが集中してサービスが過負荷になるのを防ぐ仕組みです。',
      ),
    ).toBe('ja');
    expect(
      guessLangFromScript('速率限制保护服务免受短时间内过多请求的影响，是一种常见的技术手段。'),
    ).toBe('zh');
    expect(
      guessLangFromScript('속도 제한은 짧은 시간에 너무 많은 요청으로부터 서비스를 보호합니다.'),
    ).toBe('ko');
    expect(
      guessLangFromScript('Rate limiting protects a service from too many requests.'),
    ).toBeUndefined();
    expect(guessLangFromScript('短い')).toBeUndefined();
  });
});

describe('PARSE_NEEDS_JS wiring', () => {
  it('HtmlParser throws PARSE_NEEDS_JS for a shell and returns null for a plain empty page', async () => {
    const p = new HtmlParser();
    await expect(
      p.parseHtml(
        shell(
          '<div id="app"></div><script type="module" src="/assets/index.js"></script><noscript>Please enable JavaScript</noscript>',
        ),
        'https://x.example/',
      ),
    ).rejects.toMatchObject({ code: 'PARSE_NEEDS_JS' });
    expect(await p.parseHtml(shell('<p>hi</p>'), 'https://x.example/')).toBeNull();
  });
  it('parseResource maps the code through and appends the remediation', async () => {
    const html = shell(
      '<div id="__nuxt"></div><script id="__NUXT_DATA__" type="application/json">[]</script>',
    );
    const out = await parseResource(
      {
        url: 'https://x.example/app',
        finalUrl: 'https://x.example/app',
        status: 200,
        contentType: 'text/html',
        bytes: new TextEncoder().encode(html),
        headers: {},
        redirects: 0,
      } as any,
      {},
    );
    expect(out.ok).toBe(false);
    expect(out.failure?.code).toBe('PARSE_NEEDS_JS');
    expect(out.failure?.message).toContain('ingestion.render');
  });
});
