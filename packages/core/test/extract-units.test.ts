/** Unit tests for the extraction helper modules (ingest/extract-*.ts) and their wiring. */
import { parseHTML } from 'linkedom';
import { htmlToMarkdown } from 'mdream';
import { describe, expect, it } from 'vitest';
import { type BoilerplateChunk, HostBoilerplateIndex } from '../src/ingest/extract-boilerplate.js';
import {
  detectJsShell,
  guessLangFromScript,
  normalizeLangTag,
} from '../src/ingest/extract-detect.js';
import {
  type Candidate,
  candidateFrom,
  chooseCandidate,
  classifyPageType,
  findMainRoot,
  removeChrome,
} from '../src/ingest/extract-ensemble.js';
import { extractMeta } from '../src/ingest/extract-meta.js';
import { detectLang, prepassDocument } from '../src/ingest/extract-prepass.js';
import {
  longestContentField,
  prestripScripts,
  recoverArticleBody,
  recoverFromStash,
} from '../src/ingest/extract-recover.js';
import { parseResource } from '../src/ingest/index.js';
import { HtmlParser, tidyMarkdown } from '../src/ingest/parsers.js';
import { ingestDocument } from '../src/pipeline/ingest-stage.js';
import { ephemeralSession } from '../src/pipeline/session.js';
import { contentHash } from '../src/util/hash.js';

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

describe('extract-prepass', () => {
  const dom = (body: string) =>
    parseHTML(`<!doctype html><html><body>${body}</body></html>`).document;
  const md = (body: string) => {
    const document = dom(body);
    prepassDocument(document);
    return tidyMarkdown(htmlToMarkdown(document.documentElement.outerHTML));
  };
  it('flattens Prism/Shiki/hljs token soup into fenced blocks with the language', () => {
    expect(
      md(
        '<pre class="prism-code language-ts"><code><span class="token-line"><span class="token keyword">const</span><span class="token plain"> a = 1;</span></span>\n<span class="token-line"><span class="token plain">let b;</span></span></code></pre>',
      ),
    ).toBe('```ts\nconst a = 1;\nlet b;\n```');
    expect(
      md(
        '<pre class="shiki" data-language="go"><code><span class="line"><span style="color:#f00">func</span> main() {}</span>\n<span class="line">x</span></code></pre>',
      ),
    ).toBe('```go\nfunc main() {}\nx\n```');
    expect(
      md(
        '<pre><code class="hljs python"><span class="hljs-keyword">def</span> f(): pass</code></pre>',
      ),
    ).toBe('```python\ndef f(): pass\n```');
    expect(
      md(
        '<div class="highlight-rust"><div class="highlight"><pre><span></span>fn main() {}</pre></div></div>',
      ),
    ).toBe('```rust\nfn main() {}\n```');
    expect(
      md(
        '<pre data-lang="bash"><code class="lang-bash">ls -la<span aria-hidden="true" class="line-numbers-rows"><span></span></span></code></pre>',
      ),
    ).toBe('```bash\nls -la\n```');
  });
  it('drops copy buttons and line-number gutters, collapses line-number tables', () => {
    expect(
      md('<pre><code class="language-js">x = 1;</code> <button class="copy">Copy</button></pre>'),
    ).toBe('```js\nx = 1;\n```');
    const table =
      '<table class="highlighttable"><tr><td class="linenos"><div class="linenodiv"><pre><span class="normal">1</span>\n<span class="normal">2</span></pre></div></td><td class="code"><div class="highlight"><pre><code class="language-lua">local a = 1\nreturn a</code></pre></div></td></tr></table>';
    expect(md(table)).toBe('```lua\nlocal a = 1\nreturn a\n```');
    const github =
      '<table class="highlight tab-size js-file-line-container" data-tab-size="8"><tr><td class="blob-num">1</td><td class="blob-code">import x</td></tr><tr><td class="blob-num">2</td><td class="blob-code">print(x)</td></tr></table>';
    expect(md(github)).toBe('```\nimport x\nprint(x)\n```');
    expect(md('<pre><span class="linenos">1</span>a\n<span class="linenos">2</span>b</pre>')).toBe(
      '```\na\nb\n```',
    );
  });
  it('removes heading self-links but keeps heading text', () => {
    expect(
      md('<h2 id="a">Title<a class="headerlink" href="#a" title="Link to this heading">¶</a></h2>'),
    ).toBe('## Title');
    expect(md('<h2 id="a"><a class="heading-anchor" href="#a">Title</a></h2>')).toBe('## Title');
    expect(md('<h3>Class: X<span><a class="mark" href="#x">#</a></span></h3>')).toBe(
      '### Class: X',
    );
    expect(md('<h2><a href="/other">Real link</a></h2>')).toBe('## [Real link](/other)');
  });
  it('marks data tables with summary and leaves layout tables alone', () => {
    const d = dom(
      '<table><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr><tr><td>c</td><td>3</td></tr></table><table role="presentation"><tr><td>x</td><td>y</td></tr><tr><td>x</td><td>y</td></tr></table><table><tr><td><table><tr><td>n</td></tr></table></td><td>z</td></tr></table>',
    );
    prepassDocument(d);
    const tables = [...d.querySelectorAll('table')];
    expect(tables[0].getAttribute('summary')).toBe('data table');
    expect(tables[1].getAttribute('summary')).toBeNull();
    expect(tables[2].getAttribute('summary')).toBeNull();
  });
  it('tidyMarkdown keeps indentation inside fences and collapses runs outside', () => {
    expect(tidyMarkdown('a      b\n\n```py\n    x = 1\n        y\n```\n\nc     d')).toBe(
      'a  b\n\n```py\n    x = 1\n        y\n```\n\nc  d',
    );
  });
  it('detectLang normalises aliases', () => {
    const d = dom(
      '<pre class="language-JavaScript"><code>x</code></pre><pre><code class="lang-py3">y</code></pre><pre class="line-numbers"><code>z</code></pre>',
    );
    const pres = [...d.querySelectorAll('pre')];
    expect(detectLang(pres[0])).toBe('js');
    expect(detectLang(pres[1])).toBe('python');
    expect(detectLang(pres[2])).toBeUndefined();
  });
});

describe('extract-ensemble', () => {
  const doc = (body: string, head = '') =>
    parseHTML(
      `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`,
    ).document;
  const metaOf = (d: any, url = 'https://x.example/p') => extractMeta(d, url);
  const prose = (n: number) =>
    `<p>${'Plain prose sentence about caching that is long enough to count. '.repeat(n)}</p>`;

  it('classifies Q&A by JSON-LD or post density, docs by TechArticle/kind/layout, pre by share', () => {
    const qa = doc('<p>x</p>', '<script type="application/ld+json">{"@type":"QAPage"}</script>');
    expect(classifyPageType(qa, metaOf(qa))).toBe('qa');
    const forum = doc(
      `<div class="post">${prose(2)}</div><div class="post">${prose(2)}</div><div class="post">${prose(2)}</div>`,
    );
    expect(classifyPageType(forum, metaOf(forum))).toBe('qa');
    const tech = doc(
      '<p>x</p>',
      '<script type="application/ld+json">{"@type":"TechArticle"}</script>',
    );
    expect(classifyPageType(tech, metaOf(tech))).toBe('docs');
    const layout = doc(
      `<nav><a href="/">a</a></nav><main>${prose(3)}<pre>a</pre><pre>b</pre></main>`,
    );
    expect(classifyPageType(layout, metaOf(layout))).toBe('docs');
    const pre = doc(`<pre>${'text line that is long enough to matter\n'.repeat(60)}</pre>`);
    expect(classifyPageType(pre, metaOf(pre))).toBe('pre');
    const art = doc(`<article>${prose(5)}</article>`);
    expect(classifyPageType(art, metaOf(art))).toBe('article');
  });

  it('candidateFrom measures text, link density, structure and junk', () => {
    const c = candidateFrom(
      'x',
      '# H\n\nSome text [link](u) more.\n\n```js\nx\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAccept all cookies. Subscribe to our newsletter.',
    );
    expect(c.headings).toBe(1);
    expect(c.codeBlocks).toBe(1);
    expect(c.tableRows).toBe(2);
    expect(c.linkDensity).toBeGreaterThan(0);
    expect(c.junkPer1k).toBeGreaterThan(0);
    expect(c.score).toBeGreaterThan(0);
  });

  it('chooseCandidate applies the recall guard and article preference', () => {
    const mk = (over: Partial<Candidate>): Candidate => ({
      name: 'c',
      markdown: '',
      textLen: 1000,
      linkDensity: 0.05,
      headings: 2,
      codeBlocks: 0,
      tableRows: 0,
      junkPer1k: 0,
      score: 1,
      ...over,
    });
    const r = mk({ name: 'readability' });
    expect(
      chooseCandidate({
        readability: r,
        full: mk({ name: 'full', textLen: 1500 }),
        minArticleChars: 300,
      })?.candidate.name,
    ).toBe('readability');
    expect(
      chooseCandidate({
        readability: r,
        full: mk({ name: 'full', textLen: 4000 }),
        minArticleChars: 300,
      })?.guard,
    ).toBe('text-recall');
    expect(
      chooseCandidate({
        readability: r,
        full: mk({ name: 'full', textLen: 1500, codeBlocks: 4 }),
        minArticleChars: 300,
      })?.guard,
    ).toBe('code-recall');
    expect(
      chooseCandidate({
        readability: r,
        full: mk({ name: 'full', textLen: 1500, tableRows: 8 }),
        minArticleChars: 300,
      })?.guard,
    ).toBe('table-recall');
    expect(
      chooseCandidate({
        readability: mk({ textLen: 100 }),
        full: mk({ name: 'full', textLen: 1500 }),
        minArticleChars: 300,
      })?.guard,
    ).toBe('thin-article');
    // link-heavy full page never wins on length alone
    expect(
      chooseCandidate({
        readability: r,
        full: mk({ name: 'full', textLen: 9000, linkDensity: 0.7 }),
        minArticleChars: 300,
      })?.candidate.name,
    ).toBe('readability');
    expect(
      chooseCandidate({ readability: undefined, full: mk({ name: 'full' }), minArticleChars: 300 })
        ?.guard,
    ).toBe('no-article');
    // a clean <article> beats a Readability pick that swallowed a file table
    expect(
      chooseCandidate({
        readability: mk({ tableRows: 7 }),
        full: mk({ name: 'full', textLen: 1400, tableRows: 7 }),
        article: mk({ name: 'article', textLen: 850 }),
        minArticleChars: 300,
      })?.candidate.name,
    ).toBe('article');
  });

  it('removeChrome drops page chrome but keeps article headers and content-bearing footers', () => {
    const d = doc(
      `<header class="site">Site nav</header><nav>Nav</nav><main><article><header><h1>Title</h1><p>By A</p></header>${prose(3)}<footer><a href="/e">Edit</a> <a href="/h">Helpful?</a></footer></article><aside>Related</aside></main><footer>© Foot</footer>`,
    );
    removeChrome(d.body);
    const t = d.body.textContent.replace(/\s+/g, ' ');
    expect(t).toContain('Title');
    expect(t).toContain('By A');
    expect(t).not.toContain('Site nav');
    expect(t).not.toContain('Related');
    expect(t).not.toContain('© Foot');
    expect(t).not.toContain('Edit');
  });

  it('findMainRoot prefers the most specific container that still holds most of the text', () => {
    const d = doc(
      `<div id="content"><div class="colnav"><ul>${'<li><a href="/x">Nav item</a></li>'.repeat(20)}</ul></div><div id="apicontent">${prose(20)}</div></div>`,
    );
    expect(findMainRoot(d)?.id).toBe('apicontent');
  });

  it('HtmlParser strategy: auto keeps forum answers, readability drops them, full converts everything', async () => {
    const answers = Array.from(
      { length: 3 },
      (_, i) =>
        `<div class="answer" id="answer-${i}"><div class="s-prose"><p>Answer ${i}: ${'a detailed explanation with plenty of words to count as content. '.repeat(6)}</p></div><div class="comments"><div class="comment">Comment on ${i} that is reasonably long to be seen.</div></div></div>`,
    ).join('');
    const html = `<!doctype html><html><head><title>Q</title><script type="application/ld+json">{"@type":"QAPage"}</script></head><body><nav><a href="/">Home</a><a href="/q">Questions</a></nav><div id="content"><h1>How do buckets work?</h1><div class="question"><p>${'The question body explains the confusion in some detail. '.repeat(5)}</p></div><h2>3 Answers</h2>${answers}</div><div id="sidebar"><h4>Hot questions</h4><ul>${'<li><a href="/h">Hot thing</a></li>'.repeat(10)}</ul></div><footer>© Q&A Inc</footer></body></html>`;
    const auto = await new HtmlParser().parseHtml(html, 'https://qa.example/q/1');
    expect(auto?.parser).toMatch(/^mdream-full/);
    expect(auto?.markdown).toContain('Answer 2:');
    expect(auto?.markdown).toContain('Comment on 1');
    expect(auto?.markdown).not.toContain('Hot thing');
    expect(auto?.markdown).not.toContain('© Q&A Inc');
    const full = await new HtmlParser({ strategy: 'full' }).parseHtml(
      html,
      'https://qa.example/q/1',
    );
    expect(full?.parser).toMatch(/^mdream-full/);
    expect(full?.markdown).toContain('Answer 2:');
    const rd = await new HtmlParser({ strategy: 'readability' }).parseHtml(
      html,
      'https://qa.example/q/1',
    );
    expect(rd?.parser).toMatch(/^readability|mdream-full/);
  });

  it('HtmlParser recall guard picks the full page when Readability keeps a fraction of it', async () => {
    // Many short sibling sections: Readability keeps the densest one; the guard restores the rest.
    const sections = Array.from(
      { length: 12 },
      (_, i) =>
        `<section><h2>Section ${i}</h2><p>${`Section ${i} explains one distinct facet of the topic in a few sentences. `.repeat(3)}</p><table><tr><th>k</th><th>v</th></tr><tr><td>a${i}</td><td>${i}</td></tr><tr><td>b${i}</td><td>${i * 2}</td></tr></table></section>`,
    ).join('');
    const html = `<!doctype html><html><head><title>Ref</title></head><body><nav><a href="/">Home</a></nav><div class="wrapper"><div class="lead"><p>${'Lead paragraph that Readability likes because it is dense and long. '.repeat(15)}</p></div>${sections}</div><footer>© Foot</footer></body></html>`;
    const d = await new HtmlParser().parseHtml(html, 'https://ref.example/all');
    expect(d?.markdown).toContain('Section 11');
    expect(d?.markdown).not.toContain('© Foot');
  });
});

describe('extract-recover', () => {
  const big = `{"junk":"${'x'.repeat(20_000)}"}`;
  it('prestripScripts removes big scripts, keeps ld+json, stashes framework payloads', () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"Article"}</script><script>${big}</script><script>var a=1;</script></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"x":1}}}</script><script>self.__next_f.push([1,"1:\\"hello\\"\\n"])</script><script>self.__next_f.push([1,"2:T5,world"])</script></body></html>`;
    const { html: out, stash } = prestripScripts(html);
    expect(out).toContain('"@type":"Article"');
    expect(out).toContain('var a=1;');
    expect(out).not.toContain('x'.repeat(100));
    expect(stash.nextData).toContain('pageProps');
    expect(stash.nextFlight).toBe('1:"hello"\n2:T5,world');
    expect(stash.strippedBytes).toBeGreaterThan(20_000);
  });
  it('longestContentField picks sentence-like text under content-ish keys only', () => {
    const para = 'This is a real sentence about buckets that goes on for a while. '.repeat(12);
    const v = {
      a: { title: para, content: para, meta: { id: 'x'.repeat(2000) } },
      b: [{ description: `${para}${para}` }],
    };
    expect(longestContentField(v)).toBe(`${para}${para}`);
    expect(longestContentField({ token: 'a'.repeat(3000) })).toBeUndefined();
    expect(longestContentField({ content: 'https://a.example/x '.repeat(200) })).toBeUndefined();
  });
  it('recoverFromStash converts HTML content fields and RSC text chunks to markdown', () => {
    const html = `<p>${'A sentence with words that count as content here. '.repeat(15)}</p><h2>Head</h2><p>${'More sentences follow in the second paragraph now. '.repeat(10)}</p>`;
    const r = recoverFromStash(
      {
        nextData: JSON.stringify({ props: { pageProps: { post: { content: html } } } }),
        strippedBytes: 0,
      },
      (s) => s.trim(),
    );
    expect(r?.source).toBe('next-data');
    expect(r?.markdown).toContain('## Head');
    const text = 'Plain sentence number one about parsers. '.repeat(30);
    const f = recoverFromStash(
      {
        nextFlight: `1:I["x"]\n2:T${text.length.toString(16)},${text}\n3:["$","div",null,{"children":"$L4"}]`,
        strippedBytes: 0,
      },
      (s) => s.trim(),
    );
    expect(f?.source).toBe('next-flight');
    expect(f?.markdown).toContain('Plain sentence number one');
  });
  it('recoverArticleBody honours the paywall flag strictly', () => {
    const body = 'A long enough article body sentence to pass the threshold easily. '.repeat(15);
    expect(recoverArticleBody(body, undefined, (s) => s)).toBeTruthy();
    expect(recoverArticleBody(body, true, (s) => s)).toBeTruthy();
    expect(recoverArticleBody(body, false, (s) => s)).toBeUndefined();
    expect(recoverArticleBody('short', true, (s) => s)).toBeUndefined();
  });
  it('HtmlParser recovers from __NEXT_DATA__ only when the DOM is thin, never for paywalled JSON-LD', async () => {
    const content = `<p>${'The recovered article explains everything in full sentences here. '.repeat(20)}</p>`;
    const thinHtml = `<!doctype html><html><head><title>Post</title></head><body><div id="__next"><main><h1>Post</h1><div class="skeleton"></div></main></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { post: { content } } } })}</script></body></html>`;
    const thin = await new HtmlParser().parseHtml(thinHtml, 'https://n.example/p');
    expect(thin?.parser).toBe('next-data');
    expect(thin?.markdown).toContain('The recovered article');
    expect(thin?.markdown.startsWith('# Post')).toBe(true);
    const richHtml = thinHtml.replace(
      '<div class="skeleton"></div>',
      `<article><p>${'Visible server-rendered text that is the real page content. '.repeat(20)}</p></article>`,
    );
    const rich = await new HtmlParser().parseHtml(richHtml, 'https://n.example/p');
    expect(rich?.parser).not.toBe('next-data');
    expect(rich?.markdown).toContain('Visible server-rendered');
    const paidHtml = `<!doctype html><html><head><title>Paid</title><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false,"articleBody":"${'Secret paragraph sentence that must never surface. '.repeat(20)}"}</script></head><body><main><h1>Paid</h1><p>Teaser only here, subscribe to read the rest of this story today.</p></main></body></html>`;
    const paid = await new HtmlParser().parseHtml(paidHtml, 'https://p.example/a');
    expect(paid === null || !paid.markdown.includes('Secret paragraph')).toBe(true);
    const freeHtml = paidHtml
      .replace('"isAccessibleForFree":false', '"isAccessibleForFree":true')
      .replace('Secret paragraph', 'Free paragraph');
    const free = await new HtmlParser().parseHtml(freeHtml, 'https://p.example/a');
    expect(free?.parser).toBe('jsonld-body');
    expect(free?.markdown).toContain('Free paragraph');
    const off = await new HtmlParser({ useJsonLdBody: false }).parseHtml(
      freeHtml,
      'https://p.example/a',
    );
    expect(off === null || off.parser !== 'jsonld-body').toBe(true);
  });
});

describe('same-host boilerplate suppression', () => {
  const nav = `Home Products Pricing Docs Blog Careers Contact Subscribe to our newsletter for updates every week. ${'Footer link text here. '.repeat(6)}`;
  const body = (i: number) =>
    `Unique article body number ${i}. ${`Sentence ${i} about caching and freshness with different words each time. `.repeat(12)}`;
  const mk = (id: string, url: string, text: string): BoilerplateChunk => ({
    id,
    url,
    text,
    contentHash: contentHash(text),
  });

  it('drops repeated blocks on later pages, retracts the earlier copy, keeps code and unique text', () => {
    const idx = new HostBoilerplateIndex();
    const p1 = idx.judge('https://h.example/a', [
      mk('a-nav', 'https://h.example/a', nav),
      mk('a-body', 'https://h.example/a', body(1)),
      mk('a-code', 'https://h.example/a', `\`\`\`js\n${nav}\n\`\`\``),
    ]);
    expect(p1.drop.size).toBe(0);
    const p2 = idx.judge('https://h.example/b', [
      mk('b-nav', 'https://h.example/b', nav),
      mk('b-body', 'https://h.example/b', body(2)),
      mk('b-code', 'https://h.example/b', `\`\`\`js\n${nav}\n\`\`\``),
    ]);
    expect([...p2.drop]).toEqual(['b-nav']);
    expect([...p2.retract]).toEqual(['a-nav']);
    expect(p2.duplicatePage).toBe(false);
    // near-verbatim variant (active item differs) is caught by shingles
    const p3 = idx.judge('https://h.example/c', [
      mk('c-nav', 'https://h.example/c', `${nav} (current: Blog)`),
      mk('c-body', 'https://h.example/c', body(3)),
    ]);
    expect(p3.drop.has('c-nav')).toBe(true);
    // other hosts are independent
    const other = idx.judge('https://other.example/a', [
      mk('o-nav', 'https://other.example/a', nav),
    ]);
    expect(other.drop.size).toBe(0);
  });
  it('treats a page that repeats an earlier page as a duplicate (drop only, no retraction)', () => {
    const idx = new HostBoilerplateIndex();
    const chunks = (u: string) => [
      mk(`${u}-1`, u, body(1)),
      mk(`${u}-2`, u, body(2)),
      mk(`${u}-3`, u, body(3)),
    ];
    idx.judge('https://h.example/x', chunks('https://h.example/x'));
    const dup = idx.judge('https://h.example/x?page=1', chunks('https://h.example/x?page=1'));
    expect(dup.duplicatePage).toBe(true);
    expect(dup.drop.size).toBe(3);
    expect(dup.retract.size).toBe(0);
  });
  it('ingestDocument drops shared chunks and retracts earlier ones from the lexical index', async () => {
    const session = ephemeralSession();
    const c = { embedder: undefined, countTokens: undefined } as any;
    const cache = { get: () => undefined, set: () => {} } as any;
    const md = (i: number) => `# Page ${i}\n\n${body(i)}\n\n## Footer\n\n${nav}`;
    const ingest = (i: number, drop?: boolean) =>
      ingestDocument(c, cache, {
        doc: {
          url: `https://h.example/p${i}`,
          title: `P${i}`,
          markdown: md(i),
          text: md(i),
          contentType: 'text/html',
          parser: 'x',
        },
        page: { pageHash: `h${i}`, fetchedAt: 'now' },
        query: 'q',
        session,
        chunking: { chunkSize: 200, chunkOverlap: 0, maxChunks: 20, dropSharedBoilerplate: drop },
      });
    const a = await ingest(1);
    const navA = a.chunks.find((ch) => ch.text.includes('Subscribe to our newsletter'));
    expect(navA).toBeDefined();
    expect(session.bm25.has(navA!.id)).toBe(true);
    const b = await ingest(2);
    expect(b.chunks.some((ch) => ch.text.includes('Subscribe to our newsletter'))).toBe(false);
    expect(session.bm25.has(navA!.id)).toBe(false);
    expect(session.chunks.has(navA!.id)).toBe(false);
    expect(b.chunks.some((ch) => ch.text.includes('Unique article body number 2'))).toBe(true);
    // opt-out keeps everything
    const s2 = ephemeralSession();
    const ingestOff = (i: number) =>
      ingestDocument(c, cache, {
        doc: {
          url: `https://h.example/p${i}`,
          title: `P${i}`,
          markdown: md(i),
          text: md(i),
          contentType: 'text/html',
          parser: 'x',
        },
        page: { pageHash: `h${i}`, fetchedAt: 'now' },
        query: 'q',
        session: s2,
        chunking: { chunkSize: 200, chunkOverlap: 0, maxChunks: 20, dropSharedBoilerplate: false },
      });
    await ingestOff(1);
    const off = await ingestOff(2);
    expect(off.chunks.some((ch) => ch.text.includes('Subscribe to our newsletter'))).toBe(true);
  });
});
