/** Unit tests for the extraction helper modules (ingest/extract-*.ts) and their wiring. */
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  detectJsShell,
  guessLangFromScript,
  normalizeLangTag,
} from '../src/ingest/extract-detect.js';
import { extractMeta } from '../src/ingest/extract-meta.js';
import { parseResource } from '../src/ingest/index.js';
import { HtmlParser } from '../src/ingest/parsers.js';
import { ingestDocument } from '../src/pipeline/ingest-stage.js';
import { ephemeralSession } from '../src/pipeline/session.js';

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

describe('extractMeta', () => {
  const meta = (head: string, url = 'https://site.example/a/b', body = '<p>x</p>') =>
    extractMeta(
      parseHTML(
        `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`,
      ).document,
      url,
    );
  it('prefers explicit published/modified meta and reads JSON-LD, itemprop and <time>', () => {
    const m = meta(
      `<meta property="article:published_time" content="2026-03-14T09:30:00Z"><meta property="og:updated_time" content="2026-03-15T11:00:00Z">`,
    );
    expect(m.publishedAt).toBe('2026-03-14T09:30:00Z');
    expect(m.updatedAt).toBe('2026-03-15T11:00:00Z');
    const j = meta(
      `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"BlogPosting","headline":"H","datePublished":"2025-01-02","dateModified":"2025-02-03","author":[{"@type":"Person","name":"A"},{"@type":"Person","name":"B"}]}]}</script>`,
    );
    expect(j.publishedAt).toBe('2025-01-02');
    expect(j.updatedAt).toBe('2025-02-03');
    expect(j.byline).toBe('A, B');
    expect(j.title).toBe('H');
    expect(j.kind).toBe('blog');
    const t = meta(
      '',
      'https://site.example/p',
      '<article><time datetime="2024-05-06">May</time><p>x</p></article>',
    );
    expect(t.publishedAt).toBe('2024-05-06');
    const i = meta(
      '',
      'https://site.example/p',
      '<div itemprop="dateModified" content="2024-07-08"></div>',
    );
    expect(i.updatedAt).toBe('2024-07-08');
  });
  it('falls back to a date in the URL path only when nothing else is declared', () => {
    expect(meta('', 'https://site.example/2024/07/09/slug').publishedAt).toBe('2024-07-09');
    expect(meta('', 'https://site.example/2024-07-09-slug').publishedAt).toBe('2024-07-09');
    expect(meta('', 'https://site.example/2024/13/09/slug').publishedAt).toBeUndefined();
    expect(meta('', 'https://site.example/v2024/07/09').publishedAt).toBeUndefined();
    expect(
      meta('<meta name="date" content="2020-01-01">', 'https://site.example/2024/07/09/x')
        .publishedAt,
    ).toBe('2020-01-01');
  });
  it('sanitises canonical URLs and collects hreflang alternates', () => {
    expect(meta('<link rel="canonical" href="/a/b?x=1">').canonicalUrl).toBe(
      'https://site.example/a/b?x=1',
    );
    expect(meta('<link rel="canonical" href="https://www.other.example/a/b">').canonicalUrl).toBe(
      'https://www.other.example/a/b',
    );
    expect(meta('<link rel="canonical" href="/">').canonicalUrl).toBeUndefined();
    expect(meta('<link rel="canonical" href="ftp://x/y">').canonicalUrl).toBeUndefined();
    expect(
      meta('<meta property="og:url" content="https://site.example/a/b#frag">').canonicalUrl,
    ).toBe('https://site.example/a/b');
    const m = meta(
      '<link rel="alternate" hreflang="en" href="/en/a"><link rel="alternate" hreflang="x-default" href="https://site.example/a">',
    );
    expect(m.alternates).toEqual([
      { lang: 'en', url: 'https://site.example/en/a' },
      { lang: 'x-default', url: 'https://site.example/a' },
    ]);
  });
  it('classifies page kind from JSON-LD, og:type, generator and path', () => {
    const ld = (t: string) => `<script type="application/ld+json">{"@type":"${t}"}</script>`;
    expect(
      meta(
        '<script type="application/ld+json">{"@type":"QAPage","mainEntity":{"@type":"Question"}}</script>',
      ).kind,
    ).toBe('qa');
    expect(meta(ld('TechArticle')).kind).toBe('docs');
    expect(meta(ld('NewsArticle')).kind).toBe('news');
    expect(meta(ld('Product')).kind).toBe('product');
    expect(meta('<meta property="og:type" content="video.other">').kind).toBe('video');
    expect(meta('<meta property="og:type" content="article">').kind).toBe('article');
    expect(
      meta('<meta property="og:type" content="article">', 'https://site.example/blog/x').kind,
    ).toBe('blog');
    expect(meta('<meta name="generator" content="Sphinx 7.2">').kind).toBe('docs');
    expect(meta('', 'https://site.example/docs/x').kind).toBe('docs');
    expect(meta('').kind).toBe('other');
  });
  it('reads the paywall flag strictly (node or hasPart, boolean or string) and the articleBody', () => {
    const paid = meta(
      '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":"False","articleBody":"secret"}</script>',
    );
    expect(paid.accessibleForFree).toBe(false);
    expect(paid.articleBody).toBe('secret');
    const part = meta(
      '<script type="application/ld+json">{"@type":"Article","isAccessibleForFree":true,"hasPart":[{"@type":"WebPageElement","isAccessibleForFree":false,"cssSelector":".paywall"}]}</script>',
    );
    expect(part.accessibleForFree).toBe(false);
    expect(
      meta(
        '<script type="application/ld+json">{"@type":"Article","isAccessibleForFree":true}</script>',
      ).accessibleForFree,
    ).toBe(true);
    expect(
      meta('<script type="application/ld+json">{"@type":"Article"}</script>').accessibleForFree,
    ).toBeUndefined();
    expect(meta('<script type="application/ld+json">{bad json</script>').jsonLdTypes).toEqual([]);
  });
  it('resolves language from lang attr, Content-Language, og:locale, JSON-LD', () => {
    expect(
      extractMeta(parseHTML('<html lang="EN-us"><body></body></html>').document, 'https://x/').lang,
    ).toBe('en-US');
    expect(meta('<meta http-equiv="content-language" content="de-DE">').lang).toBe('de-DE');
    expect(meta('<meta property="og:locale" content="fr_FR">').lang).toBe('fr-FR');
    expect(
      meta('<script type="application/ld+json">{"@type":"Article","inLanguage":"pt-BR"}</script>')
        .lang,
    ).toBe('pt-BR');
  });
});

describe('ingestDocument metadata + canonical dedupe', () => {
  it('uses doc.canonicalUrl as the dedupe key and carries dates/kind into chunk metadata', async () => {
    const session = ephemeralSession();
    const c = { embedder: undefined, countTokens: undefined } as any;
    const cache = { get: () => undefined, set: () => {} } as any;
    const md = `# T\n\n${'Body text about caching and freshness lifetimes. '.repeat(30)}`;
    const base = {
      title: 'T',
      markdown: md,
      text: md,
      contentType: 'text/html',
      parser: 'x',
      publishedAt: '2026-01-01',
      updatedAt: '2026-02-02',
      kind: 'news' as const,
    };
    const chunking = { chunkSize: 200, chunkOverlap: 0, maxChunks: 10 };
    const a = await ingestDocument(c, cache, {
      doc: {
        ...base,
        url: 'https://amp.example/amp/x?utm_source=z',
        canonicalUrl: 'https://example.org/x',
      },
      page: { pageHash: 'h', fetchedAt: 'now' },
      query: 'q',
      session,
      chunking,
    });
    expect(a.chunks[0]!.metadata.canonicalUrl).toBe('https://example.org/x');
    expect(a.chunks[0]!.metadata.updatedAt).toBe('2026-02-02');
    expect(a.chunks[0]!.metadata.kind).toBe('news');
    expect(session.urls.has('https://example.org/x')).toBe(true);
    expect(session.urls.has('https://amp.example/amp/x')).toBe(true);
    // The desktop URL yields the same chunk ids → nothing is indexed twice.
    const b = await ingestDocument(c, cache, {
      doc: { ...base, url: 'https://example.org/x' },
      page: { pageHash: 'h2', fetchedAt: 'now' },
      query: 'q',
      session,
      chunking,
    });
    expect(b.chunks.map((ch) => ch.id)).toEqual(a.chunks.map((ch) => ch.id));
    expect(session.chunks.size).toBe(a.chunks.length);
  });
});
