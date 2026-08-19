/**
 * Generates the synthetic half of the extraction regression corpus (see README.md).
 *
 *   npx tsx packages/core/test/fixtures/extract/generate.mts
 *
 * Every synthetic fixture is written as `<name>.html` (the page), `<name>.gold.md` (the ideal
 * markdown = the authored content region converted with mdream, i.e. what a perfect extractor
 * would return) and `<name>.json` (expectations checked by test/extract.test.ts). Real recorded
 * pages (`*.html.gz`) come from eval/fixtures/http and are copied by `--real`.
 *
 * All prose is written for this corpus (no third-party text) so the fixtures stay licence-clean.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { htmlToMarkdown } from 'mdream';

const here = dirname(fileURLToPath(import.meta.url));

// ─── spec ───────────────────────────────────────────────────────────────────

interface Spec {
  url: string;
  /** Human description of the page type this fixture represents. */
  type: string;
  contentType?: string;
  /** Expected failure code instead of a document. */
  failure?: string;
  /** Minimum char-trigram F1 of extracted text vs gold (synthetic) or snapshot (real). */
  minF1?: number;
  mustContain?: string[];
  mustNotContain?: string[];
  /** Expected metadata (checked with toBe / toContain for strings). */
  meta?: Record<string, unknown>;
  /** Minimum extracted markdown length. */
  minChars?: number;
  /** Extracted markdown must contain at least this many fenced code blocks / table rows. */
  minCodeBlocks?: number;
  minTableRows?: number;
  /** Known gap: the test runs as `it.fails` until the named work item lands. */
  expectFail?: string;
}

interface Fixture {
  name: string;
  html: string;
  /** Content region HTML; converted to the gold markdown. Omit for failure fixtures. */
  gold?: string;
  spec: Spec;
}

const fixtures: Fixture[] = [];
const add = (f: Fixture) => fixtures.push(f);

// ─── prose pools (original text) ─────────────────────────────────────────────

const P = {
  intro:
    'Rate limiting protects a service from being overwhelmed by too many requests in a short window. Instead of failing unpredictably under load, a rate-limited service rejects or delays excess requests in a controlled way, and tells the client when it may try again.',
  tokenBucket:
    'The token bucket algorithm keeps a counter of available tokens that refills at a fixed rate up to a maximum capacity. Each request consumes one token; when the bucket is empty the request is rejected. Because tokens accumulate while the service is idle, the bucket tolerates short bursts without exceeding the long-term average rate.',
  leakyBucket:
    'A leaky bucket smooths traffic instead of tolerating bursts: requests enter a queue that drains at a constant rate, and requests arriving when the queue is full are dropped. It produces a very even output rate at the cost of added latency for bursty clients.',
  slidingWindow:
    'Sliding window counters approximate a true rolling window by weighting the previous fixed window by how much of it still overlaps the current one. They need only two counters per client, which makes them cheap to store in a shared cache such as Redis.',
  headers:
    'Servers commonly signal limits with the RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset headers, and answer rejected requests with HTTP status 429 Too Many Requests together with a Retry-After header. Clients that honour Retry-After avoid making the overload worse.',
  distributed:
    'In a distributed deployment the counters must be shared, otherwise each instance enforces its own limit and the effective limit becomes the sum across instances. A central store introduces a network round trip per request, so many systems combine a local pre-filter with a periodic sync to the shared counter.',
  conclusion:
    'Choosing an algorithm is mostly a question of what you want to protect: a database that degrades under bursts prefers a leaky bucket, an API that sells quota to customers prefers a token bucket, and a shared cache with limited memory prefers sliding windows.',
  cachingIntro:
    'HTTP caching lets a response be reused for later requests instead of being generated again. Reuse is governed by freshness: a stored response is fresh until its age exceeds the lifetime the origin granted, and after that it must be revalidated before use.',
  cachingMaxAge:
    'The max-age directive of Cache-Control gives the freshness lifetime in seconds relative to the time the response was generated. It takes precedence over the Expires header when both are present, and a shared cache honours s-maxage over max-age.',
  cachingRevalidate:
    'Revalidation sends a conditional request carrying the validator of the stored response, either an entity tag in If-None-Match or a date in If-Modified-Since. A 304 Not Modified answer refreshes the stored response without transferring the body again.',
  cachingHeuristic:
    'When a response has neither an explicit lifetime nor a validator, caches may assign a heuristic freshness lifetime, typically ten percent of the time since Last-Modified. Explicit directives are always preferable because heuristics vary between implementations.',
  cachingVary:
    'The Vary header lists the request headers that selected this representation. A cache must not reuse the stored response for a request whose listed header values differ, which is how content negotiation on Accept-Encoding or Accept-Language stays correct.',
  parserIntro:
    'A tokenizer turns a stream of characters into tokens such as identifiers, numbers and punctuation. The parser then consumes those tokens and builds a tree that reflects the grammar of the language, reporting an error at the first token that cannot continue any valid production.',
  parserRecursive:
    'Recursive descent parsers implement one function per grammar rule. Each function consumes the tokens that rule expects and calls the functions of the rules it references, so the call stack mirrors the shape of the parse tree while it is being built.',
  parserPratt:
    'Pratt parsing handles operator precedence by giving each operator a binding power. A loop keeps extending the current expression while the next operator binds more tightly than the surrounding context allows, which avoids one grammar rule per precedence level.',
  parserErrors:
    'Good error recovery matters more than speed for interactive tools. A common strategy is to synchronise on statement boundaries: after an error the parser skips tokens until it sees a semicolon or a keyword that starts a statement, then continues so that one typo does not hide every later error.',
};

const para = (...keys: (keyof typeof P)[]) => keys.map((k) => `<p>${P[k]}</p>`).join('\n');

// ─── chrome (boilerplate the extractor should drop) ──────────────────────────

const NAV_LINKS = ['Home', 'Products', 'Pricing', 'Docs', 'Blog', 'Careers', 'Contact'];
const siteHeader = (site: string) => `
<header class="site-header" role="banner">
  <a class="logo" href="/">${site}</a>
  <nav aria-label="Main navigation" class="main-nav">
    <ul>${NAV_LINKS.map((l) => `<li><a href="/${l.toLowerCase()}">${l}</a></li>`).join('')}</ul>
  </nav>
  <form class="search" action="/search"><input name="q" placeholder="Search the site"><button type="submit">Search</button></form>
  <a class="btn" href="/login">Sign in</a> <a class="btn" href="/signup">Start free trial</a>
</header>`;

const siteFooter = (site: string) => `
<footer class="site-footer" role="contentinfo">
  <div class="footer-cols">
    <div><h4>Company</h4><ul><li><a href="/about">About us</a></li><li><a href="/careers">Careers at ${site}</a></li><li><a href="/press">Press kit</a></li></ul></div>
    <div><h4>Resources</h4><ul><li><a href="/docs">Documentation</a></li><li><a href="/status">System status</a></li><li><a href="/changelog">Changelog</a></li></ul></div>
    <div><h4>Legal</h4><ul><li><a href="/privacy">Privacy policy</a></li><li><a href="/terms">Terms of service</a></li><li><a href="/cookies">Cookie settings</a></li></ul></div>
  </div>
  <form class="newsletter" action="/subscribe"><label>Subscribe to our newsletter</label><input type="email" placeholder="you@example.com"><button>Subscribe</button></form>
  <p class="copyright">© 2026 ${site} Inc. All rights reserved. FOOTER-MARKER-TEXT</p>
</footer>`;

const cookieBanner = () => `
<div id="cookie-consent" class="cookie-banner" role="dialog" aria-label="Cookie consent">
  <p>We use cookies to personalise content, to provide social media features and to analyse our traffic. COOKIE-BANNER-MARKER</p>
  <button class="accept">Accept all cookies</button><button class="reject">Reject non-essential</button><a href="/cookies">Manage preferences</a>
</div>`;

const relatedAside = () => `
<aside class="sidebar related-posts">
  <h3>Related articles</h3>
  <ul>
    <li><a href="/blog/circuit-breakers">Circuit breakers explained</a></li>
    <li><a href="/blog/retries">Retries with exponential backoff</a></li>
    <li><a href="/blog/idempotency">Idempotency keys in practice</a></li>
    <li><a href="/blog/timeouts">Choosing timeouts</a></li>
  </ul>
  <div class="ad-slot">Advertisement RELATED-ASIDE-MARKER</div>
</aside>`;

const shareBar = () => `
<div class="share-bar" aria-hidden="true"><span>Share this article</span><a href="https://twitter.com/share">Twitter</a><a href="https://www.linkedin.com/share">LinkedIn</a><a href="mailto:?subject=x">Email</a> SHARE-BAR-MARKER</div>`;

const page = (o: {
  title: string;
  head?: string;
  body: string;
  lang?: string;
  bodyClass?: string;
}) => `<!DOCTYPE html>
<html${o.lang === undefined ? ' lang="en"' : o.lang ? ` lang="${o.lang}"` : ''}>
<head>
<meta charset="utf-8">
<title>${o.title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${o.head ?? ''}
<style>.site-header{display:flex}.hidden{display:none}</style>
</head>
<body${o.bodyClass ? ` class="${o.bodyClass}"` : ''}>
${o.body}
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());</script>
</body>
</html>`;

// ─── 1. article / news ───────────────────────────────────────────────────────
{
  const url = 'https://news.example.com/2026/03/14/rate-limiting-explained';
  const content = `
<h1>Rate limiting, explained for busy engineers</h1>
${para('intro', 'tokenBucket', 'leakyBucket')}
<h2>Sliding windows</h2>
${para('slidingWindow')}
<blockquote>Tell the client when it may try again; guessing makes overload worse.</blockquote>
<h2>Signalling limits to clients</h2>
${para('headers', 'distributed', 'conclusion')}`;
  add({
    name: 'article-news',
    gold: content,
    spec: {
      url,
      type: 'news article with JSON-LD NewsArticle, OG tags, dates, nav/footer/aside/share chrome',
      minF1: 0.9,
      mustContain: ['token bucket algorithm', 'RateLimit-Remaining', 'Tell the client when it may try again'],
      mustNotContain: ['FOOTER-MARKER-TEXT', 'RELATED-ASIDE-MARKER', 'SHARE-BAR-MARKER', 'Start free trial'],
      meta: {
        title: 'Rate limiting, explained for busy engineers',
        publishedAt: '2026-03-14T09:30:00Z',
        updatedAt: '2026-03-15T11:00:00Z',
        siteName: 'Example News',
        byline: 'Dana Whitfield',
        kind: 'news',
        canonicalUrl: url,
        accessibleForFree: true,
      },
    },
    html: page({
      title: 'Rate limiting, explained for busy engineers | Example News',
      head: `
<meta property="og:type" content="article">
<meta property="og:title" content="Rate limiting, explained for busy engineers">
<meta property="og:site_name" content="Example News">
<meta property="og:url" content="${url}">
<meta property="article:published_time" content="2026-03-14T09:30:00Z">
<meta property="article:modified_time" content="2026-03-15T11:00:00Z">
<meta name="author" content="Dana Whitfield">
<meta name="description" content="Token buckets, leaky buckets and sliding windows compared.">
<link rel="canonical" href="${url}">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Rate limiting, explained for busy engineers","datePublished":"2026-03-14T09:30:00Z","dateModified":"2026-03-15T11:00:00Z","author":{"@type":"Person","name":"Dana Whitfield"},"publisher":{"@type":"Organization","name":"Example News"},"isAccessibleForFree":true}</script>`,
      body: `${siteHeader('Example News')}${cookieBanner()}
<main>
<article>
<div class="byline">By <a rel="author" href="/authors/dana">Dana Whitfield</a> · <time datetime="2026-03-14T09:30:00Z">14 March 2026</time></div>
${shareBar()}
${content}
<div class="tags">Tags: <a href="/t/api">api</a> <a href="/t/reliability">reliability</a></div>
</article>
${relatedAside()}
</main>
${siteFooter('Example News')}`,
    }),
  });
}

// ─── 2. blog with sidebar + comments count ───────────────────────────────────
{
  const url = 'https://blog.example.dev/posts/http-caching-primer';
  const content = `
<h1>An HTTP caching primer</h1>
${para('cachingIntro', 'cachingMaxAge')}
<h2>Revalidation</h2>
${para('cachingRevalidate', 'cachingHeuristic')}
<h2>Vary</h2>
${para('cachingVary')}
<p>That is all there is to it: grant a lifetime, ship a validator, and list what you varied on.</p>`;
  add({
    name: 'article-blog',
    gold: content,
    spec: {
      url,
      type: 'personal blog post (BlogPosting) with sidebar widgets, comment CTA and popular-posts list',
      minF1: 0.9,
      mustContain: ['s-maxage', 'If-None-Match', 'heuristic freshness lifetime'],
      mustNotContain: ['POPULAR-POSTS-MARKER', 'FOOTER-MARKER-TEXT', 'Leave a comment'],
      meta: { publishedAt: '2025-11-02', byline: 'Priya Natarajan' },
    },
    html: page({
      title: 'An HTTP caching primer — Priya writes',
      head: `<meta property="og:type" content="article"><meta name="author" content="Priya Natarajan"><meta name="date" content="2025-11-02">`,
      body: `${siteHeader('Priya writes')}
<div class="layout">
<main id="content">
<article class="post">
<header class="post-header"><h1>An HTTP caching primer</h1><p class="meta">Posted on <time datetime="2025-11-02">2 Nov 2025</time> · 6 min read · 12 comments</p></header>
<div class="post-body">
${content.replace('<h1>An HTTP caching primer</h1>', '')}
</div>
<footer class="post-footer"><a href="#comments" class="btn">Leave a comment</a></footer>
</article>
</main>
<aside class="widgets">
<section class="widget"><h3>Popular posts POPULAR-POSTS-MARKER</h3><ul><li><a href="/posts/a">Why my build is slow</a></li><li><a href="/posts/b">Notes on WAL mode</a></li><li><a href="/posts/c">Reading RFCs for fun</a></li></ul></section>
<section class="widget"><h3>Follow</h3><a href="https://mastodon.example/@priya">Mastodon</a> <a href="/feed.xml">RSS</a></section>
</aside>
</div>
${siteFooter('Priya writes')}`,
    }),
  });
}

// ─── 3. Docusaurus-style docs with Prism tokens + Copy buttons + TOC ────────
const prismSoup = (lines: string[], lang: string) =>
  `<div class="codeBlockContainer_Ckt0 theme-code-block"><div class="codeBlockContent_biex"><pre tabindex="0" class="prism-code language-${lang} codeBlock_bY9V thin-scrollbar"><code class="codeBlockLines_e6Vv">${lines
    .map(
      (l) =>
        `<span class="token-line" style="color:#393A34">${l
          .split(' ')
          .map((w, i) => (i % 2 ? `<span class="token punctuation">${w}</span>` : `<span class="token plain">${w}</span>`))
          .join('<span class="token plain"> </span>')}</span>`,
    )
    .join('\n')}</code></pre><div class="buttonGroup__atx"><button type="button" aria-label="Copy code to clipboard" title="Copy" class="clean-btn"><span class="copyButtonIcons_eSgA" aria-hidden="true"></span>Copy</button></div></div></div>`;

{
  const url = 'https://docs.example.io/guides/rate-limits';
  const codeGold = `<pre><code class="language-ts">import { RateLimiter } from '@example/sdk';
const limiter = new RateLimiter({ capacity: 100, refillPerSecond: 10 });
if (!limiter.tryAcquire()) { throw new Error('rate limited'); }</code></pre>`;
  const contentGold = `
<h1>Rate limits</h1>
${para('intro')}
<div class="admonition"><p><strong>note</strong></p><p>Limits apply per API key, not per IP address.</p></div>
<h2>Token bucket configuration</h2>
${para('tokenBucket')}
${codeGold}
<h2>Response headers</h2>
${para('headers')}
<table><thead><tr><th>Header</th><th>Meaning</th></tr></thead><tbody><tr><td>RateLimit-Limit</td><td>Requests allowed per window</td></tr><tr><td>RateLimit-Remaining</td><td>Requests left in the window</td></tr><tr><td>RateLimit-Reset</td><td>Seconds until the window resets</td></tr></tbody></table>
<h2>Distributed deployments</h2>
${para('distributed')}`;
  const contentHtml = contentGold.replace(
    codeGold,
    prismSoup(
      [
        "import { RateLimiter } from '@example/sdk';",
        'const limiter = new RateLimiter({ capacity: 100, refillPerSecond: 10 });',
        "if (!limiter.tryAcquire()) { throw new Error('rate limited'); }",
      ],
      'ts',
    ),
  );
  add({
    name: 'docs-docusaurus',
    gold: contentGold,
    spec: {
      url,
      type: 'Docusaurus docs page: sidebar nav, TOC aside, prev/next pagination, Prism token spans with Copy button, admonition, table',
      minF1: 0.85,
      mustContain: ['refillPerSecond', 'RateLimit-Reset', 'Limits apply per API key'],
      mustNotContain: ['SIDEBAR-MARKER', 'Copy code to clipboard', 'Edit this page', 'Was this page helpful'],
      minCodeBlocks: 1,
      minTableRows: 3,
      meta: { title: 'Rate limits', kind: 'docs' },
    },
    html: page({
      title: 'Rate limits | Example Docs',
      head: `<meta name="docusaurus_version" content="current"><meta name="generator" content="Docusaurus v3.6.0"><meta property="og:type" content="website">`,
      body: `
<nav class="navbar navbar--fixed-top" aria-label="Main"><a class="navbar__brand" href="/">Example Docs</a><div class="navbar__items"><a class="navbar__item" href="/docs">Docs</a><a class="navbar__item" href="/api">API</a><a class="navbar__item" href="/blog">Blog</a><a href="https://github.com/example/sdk">GitHub</a></div><button class="DocSearch">Search ⌘K</button></nav>
<div class="main-wrapper docsWrapper">
<aside class="theme-doc-sidebar-container"><nav class="menu thin-scrollbar" aria-label="Docs sidebar"><ul class="theme-doc-sidebar-menu menu__list">
<li class="menu__list-item"><a class="menu__link" href="/guides/intro">Introduction SIDEBAR-MARKER</a></li>
<li class="menu__list-item"><a class="menu__link" href="/guides/auth">Authentication</a></li>
<li class="menu__list-item menu__list-item--active"><a class="menu__link menu__link--active" href="/guides/rate-limits">Rate limits</a></li>
<li class="menu__list-item"><a class="menu__link" href="/guides/webhooks">Webhooks</a></li>
<li class="menu__list-item"><a class="menu__link" href="/guides/errors">Errors</a></li>
<li class="menu__list-item"><a class="menu__link" href="/guides/sdks">SDKs</a></li>
</ul></nav></aside>
<main class="docMainContainer">
<div class="container padding-top--md">
<nav class="theme-doc-breadcrumbs breadcrumbs" aria-label="Breadcrumbs"><ul class="breadcrumbs"><li class="breadcrumbs__item"><a href="/">Home</a></li><li class="breadcrumbs__item"><a href="/guides">Guides</a></li><li class="breadcrumbs__item breadcrumbs__item--active"><span>Rate limits</span></li></ul></nav>
<article>
<div class="theme-doc-markdown markdown">
${contentHtml}
</div>
<footer class="theme-doc-footer docusaurus-mt-lg"><div class="row"><div class="col"><a href="https://github.com/example/docs/edit/main/guides/rate-limits.md" class="theme-edit-this-page">Edit this page</a></div><div class="col"><span class="theme-last-updated">Last updated on <b>Mar 2, 2026</b></span></div></div><div class="feedback">Was this page helpful? <button>Yes</button><button>No</button></div></footer>
</article>
<nav class="pagination-nav docusaurus-mt-lg" aria-label="Docs pages"><a class="pagination-nav__link pagination-nav__link--prev" href="/guides/auth"><div class="pagination-nav__sublabel">Previous</div><div class="pagination-nav__label">Authentication</div></a><a class="pagination-nav__link pagination-nav__link--next" href="/guides/webhooks"><div class="pagination-nav__sublabel">Next</div><div class="pagination-nav__label">Webhooks</div></a></nav>
</div>
<div class="col col--3"><div class="tableOfContents_bqdL thin-scrollbar theme-doc-toc-desktop"><ul class="table-of-contents table-of-contents__left-border"><li><a href="#token-bucket-configuration" class="table-of-contents__link toc-highlight">Token bucket configuration</a></li><li><a href="#response-headers" class="table-of-contents__link">Response headers</a></li><li><a href="#distributed-deployments" class="table-of-contents__link">Distributed deployments</a></li></ul></div></div>
</main>
</div>
<footer class="footer footer--dark"><div class="container"><div class="row"><div class="col footer__col"><div class="footer__title">Docs</div><ul class="footer__items"><li><a href="/guides/intro">Getting started</a></li><li><a href="/api">API reference</a></li></ul></div><div class="col footer__col"><div class="footer__title">Community</div><ul><li><a href="https://discord.example">Discord</a></li><li><a href="https://x.com/example">X</a></li></ul></div></div><div class="footer__copyright">Copyright © 2026 Example, Inc. Built with Docusaurus. FOOTER-MARKER-TEXT</div></div></footer>`,
    }),
  });
}

// ─── 4. Sphinx docs (div.highlight, headerlinks, sidebar, dl definitions) ────
{
  const url = 'https://sphinx.example.org/en/stable/library/ratelimit.html';
  const contentGold = `
<h1>ratelimit — Rate limiting primitives</h1>
<p><strong>Source code:</strong> <a href="https://github.com/example/ratelimit/blob/main/ratelimit.py">ratelimit.py</a></p>
${para('intro')}
<h2>Classes</h2>
<dl class="py class"><dt id="ratelimit.TokenBucket"><em class="property">class </em><span class="sig-name descname">TokenBucket</span>(<em class="sig-param">capacity</em>, <em class="sig-param">refill_rate</em>)</dt>
<dd>${para('tokenBucket')}
<dl class="py method"><dt id="ratelimit.TokenBucket.try_acquire"><span class="sig-name descname">try_acquire</span>(<em>tokens=1</em>)</dt><dd><p>Return True and consume tokens if enough are available; otherwise return False without blocking.</p></dd></dl>
</dd></dl>
<h2>Example</h2>
<pre><code class="language-python">from ratelimit import TokenBucket

bucket = TokenBucket(capacity=100, refill_rate=10)
if not bucket.try_acquire():
    raise RuntimeError("rate limited")</code></pre>
<h2>Choosing an algorithm</h2>
${para('leakyBucket', 'conclusion')}`;
  const contentHtml = contentGold
    .replace(
      /<pre><code class="language-python">([\s\S]*?)<\/code><\/pre>/,
      (_m, code: string) =>
        `<div class="highlight-python notranslate"><div class="highlight"><pre><span></span><span class="kn">from</span> <span class="nn">ratelimit</span> <span class="kn">import</span> <span class="n">TokenBucket</span>\n\n<span class="n">bucket</span> <span class="o">=</span> <span class="n">TokenBucket</span><span class="p">(</span><span class="n">capacity</span><span class="o">=</span><span class="mi">100</span><span class="p">,</span> <span class="n">refill_rate</span><span class="o">=</span><span class="mi">10</span><span class="p">)</span>\n<span class="k">if</span> <span class="ow">not</span> <span class="n">bucket</span><span class="o">.</span><span class="n">try_acquire</span><span class="p">():</span>\n    <span class="k">raise</span> <span class="ne">RuntimeError</span><span class="p">(</span><span class="s2">&quot;rate limited&quot;</span><span class="p">)</span>\n</pre></div></div>${code ? '' : ''}`,
    )
    .replace(/<h([12])>([^<]+)<\/h[12]>/g, (_m, l, t) => `<h${l}>${t}<a class="headerlink" href="#${t.split(' ')[0].toLowerCase()}" title="Link to this heading">¶</a></h${l}>`);
  add({
    name: 'docs-sphinx',
    gold: contentGold,
    spec: {
      url,
      type: 'Sphinx/pygments docs: div.highlight code, headerlink pilcrows, sphinxsidebar, related bar, dl signatures',
      minF1: 0.85,
      mustContain: ['try_acquire', 'refill_rate=10', 'consume tokens if enough are available'],
      mustNotContain: ['SPHINX-SIDEBAR-MARKER', 'Quick search', '¶'],
      minCodeBlocks: 1,
    },
    html: page({
      title: 'ratelimit — Rate limiting primitives — Example 3.14 documentation',
      head: `<meta name="generator" content="sphinx">`,
      body: `
<div class="related" role="navigation" aria-label="Related"><h3>Navigation</h3><ul><li class="right"><a href="../genindex.html" title="General Index">index</a> |</li><li class="right"><a href="../py-modindex.html">modules</a> |</li><li class="right"><a href="threading.html">next</a> |</li><li class="right"><a href="queue.html">previous</a> |</li><li><a href="../index.html">Example 3.14 documentation</a> »</li><li><a href="index.html">The Standard Library</a> »</li><li class="nav-item">ratelimit</li></ul></div>
<div class="document"><div class="documentwrapper"><div class="bodywrapper"><div class="body" role="main">
<section id="module-ratelimit">
${contentHtml}
</section>
</div></div></div>
<div class="sphinxsidebar" role="navigation" aria-label="Main"><div class="sphinxsidebarwrapper">
<h3><a href="../contents.html">Table of Contents SPHINX-SIDEBAR-MARKER</a></h3>
<ul><li><a class="reference internal" href="#">ratelimit — Rate limiting primitives</a><ul><li><a class="reference internal" href="#classes">Classes</a></li><li><a class="reference internal" href="#example">Example</a></li><li><a class="reference internal" href="#choosing">Choosing an algorithm</a></li></ul></li></ul>
<h4>Previous topic</h4><p class="topless"><a href="queue.html">queue — A synchronized queue class</a></p>
<h4>Next topic</h4><p class="topless"><a href="threading.html">threading — Thread-based parallelism</a></p>
<div role="note" aria-label="source link"><h3>This page</h3><ul class="this-page-menu"><li><a href="../bugs.html">Report a bug</a></li><li><a href="https://github.com/example/docs/blob/main/library/ratelimit.rst">Show source</a></li></ul></div>
<div id="searchbox" style="display: none" role="search"><h3 id="searchlabel">Quick search</h3><form class="search" action="../search.html" method="get"><input type="text" name="q"><input type="submit" value="Go"></form></div>
</div></div><div class="clearer"></div></div>
<div class="footer">© Copyright 2001-2026, Example Software Foundation. FOOTER-MARKER-TEXT <a href="../copyright.html">Copyright</a> | <a href="../license.html">License</a></div>`,
    }),
  });
}

// ─── 5. Mintlify-style API reference (TechArticle, tabs, callouts, param table) ─
{
  const url = 'https://mintlify.example.com/api-reference/limits/get';
  const contentGold = `
<h1>Get rate limit status</h1>
<p><code>GET /v1/limits</code></p>
<p>Returns the caller's current quota, the number of requests remaining in the window and the reset time. The endpoint itself is exempt from rate limiting so that clients can poll it while backing off.</p>
<h2>Query parameters</h2>
<table><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody><tr><td>key</td><td>string</td><td>API key to inspect (defaults to the caller's key)</td></tr><tr><td>window</td><td>string</td><td>One of minute, hour or day</td></tr></tbody></table>
<h2>Response</h2>
<pre><code class="language-json">{
  "limit": 1000,
  "remaining": 942,
  "reset": "2026-04-01T12:00:00Z"
}</code></pre>
<div class="callout"><p>Remaining counts are eventually consistent across regions and may lag by a few seconds.</p></div>
<h2>Errors</h2>
${para('headers')}`;
  const contentHtml = contentGold.replace(
    /<pre><code class="language-json">([\s\S]*?)<\/code><\/pre>/,
    (_m, code) =>
      `<div class="code-block"><div class="code-header"><span class="code-lang">JSON</span><button class="copy-button" aria-label="Copy the contents from the code block">Copy</button></div><pre class="language-json" data-language="json"><code>${code}</code></pre></div>`,
  );
  add({
    name: 'docs-api-reference',
    gold: contentGold,
    spec: {
      url,
      type: 'Mintlify-style API reference (JSON-LD TechArticle), nav+main layout, params table, code with data-language',
      minF1: 0.85,
      mustContain: ['"remaining": 942', 'exempt from rate limiting', 'One of minute, hour or day'],
      mustNotContain: ['API-NAV-MARKER', 'Copy the contents', 'Powered by Mintlify'],
      minCodeBlocks: 1,
      minTableRows: 2,
    },
    html: page({
      title: 'Get rate limit status - Example API',
      head: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"TechArticle","headline":"Get rate limit status","dateModified":"2026-02-20"}</script><meta name="generator" content="Mintlify">`,
      body: `
<div id="navbar" class="navbar"><a href="/">Example API</a><nav aria-label="Primary"><a href="/docs">Guides</a><a href="/api-reference">API Reference</a><a href="/changelog">Changelog</a></nav><button>Search...</button><a href="https://dashboard.example.com">Dashboard</a></div>
<div class="flex">
<nav id="sidebar" class="sidebar" aria-label="Sidebar"><ul><li class="group">Limits API-NAV-MARKER<ul><li><a href="/api-reference/limits/get" aria-current="page">Get rate limit status</a></li><li><a href="/api-reference/limits/reset">Reset a limit</a></li></ul></li><li class="group">Keys<ul><li><a href="/api-reference/keys/list">List keys</a></li><li><a href="/api-reference/keys/create">Create key</a></li><li><a href="/api-reference/keys/revoke">Revoke key</a></li></ul></li></ul></nav>
<main id="content-area" class="relative">
<div class="eyebrow">Limits</div>
${contentHtml}
</main>
<aside class="toc"><p>On this page</p><ul><li><a href="#query-parameters">Query parameters</a></li><li><a href="#response">Response</a></li><li><a href="#errors">Errors</a></li></ul></aside>
</div>
<footer><a href="https://mintlify.com">Powered by Mintlify</a> · <a href="/privacy">Privacy</a> FOOTER-MARKER-TEXT</footer>`,
    }),
  });
}

// ─── 6. Q&A page (QAPage JSON-LD, answers in .answer, comments) ─────────────
{
  const url = 'https://qa.example.com/questions/48213/how-does-a-token-bucket-handle-bursts';
  const question = `<h1>How does a token bucket handle bursts?</h1>
<div class="question-body"><p>I am implementing throttling for an internal API and cannot decide between a token bucket and a fixed window counter. The docs I read say the bucket "tolerates bursts", but I do not understand how a burst is different from simply exceeding the limit. Could someone explain with numbers?</p></div>`;
  const answers = [
    `<p>The difference is what the limit is measured against. ${P.tokenBucket} With capacity 100 and refill 10 per second, a client that was idle for ten seconds may send 100 requests at once and only then is it held to 10 per second.</p><pre><code>capacity = 100
refill   = 10 / s
idle 10s  -> 100 tokens available -> burst of 100 allowed
after     -> 10 requests per second sustained</code></pre>`,
    `<p>${P.leakyBucket} So if you want smoothing rather than tolerance, pick the leaky bucket; if you want to sell a monthly quota with occasional spikes, pick the token bucket.</p>`,
    `<p>One practical note: ${P.distributed}</p>`,
  ];
  const comments = [
    'Thanks, the worked example with capacity 100 made it click.',
    'Worth adding that many CDNs expose exactly these two knobs as burst and rate.',
  ];
  const contentGold = `${question}
<h2>3 Answers</h2>
<div class="answer accepted-answer">${answers[0]}<div class="comment"><p>${comments[0]}</p></div><div class="comment"><p>${comments[1]}</p></div></div>
<div class="answer">${answers[1]}</div>
<div class="answer">${answers[2]}</div>`;
  add({
    name: 'forum-qa',
    gold: contentGold,
    spec: {
      url,
      type: 'Stack-Overflow-like Q&A (QAPage JSON-LD): question + 3 answers with vote widgets and comments; Readability drops answers',
      minF1: 0.75,
      mustContain: [
        'tolerates bursts',
        'idle 10s',
        'pick the leaky bucket',
        'many CDNs expose exactly these two knobs',
        'One practical note',
      ],
      mustNotContain: ['HOT-NETWORK-MARKER', 'FOOTER-MARKER-TEXT'],
      meta: { kind: 'qa' },
    },
    html: page({
      title: 'throttling - How does a token bucket handle bursts? - Example Q&A',
      head: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"QAPage","mainEntity":{"@type":"Question","name":"How does a token bucket handle bursts?","dateCreated":"2026-01-08T14:02:00Z","answerCount":3,"author":{"@type":"Person","name":"mira_k"}}}</script><meta property="og:type" content="website">`,
      body: `${siteHeader('Example Q&A')}
<div class="container">
<div id="mainbar">
<div id="question-header"><h1><a href="${url}" class="question-hyperlink">How does a token bucket handle bursts?</a></h1></div>
<div class="question-stats">Asked <time datetime="2026-01-08T14:02:00Z">Jan 8 at 14:02</time> · Viewed 2k times</div>
<div id="question" class="question post-layout">
<div class="votecell"><button aria-label="Up vote">▲</button><div class="js-vote-count">14</div><button aria-label="Down vote">▼</button><button aria-label="Save">☆</button></div>
<div class="postcell">${question.replace(/<h1>.*<\/h1>\n/, '')}<div class="post-taglist"><a class="post-tag" href="/questions/tagged/throttling">throttling</a> <a class="post-tag" href="/questions/tagged/api-design">api-design</a></div><div class="post-menu"><a href="/q/48213/share">Share</a> <a href="/posts/48213/edit">Edit</a> <a href="#">Follow</a></div><div class="user-info">asked Jan 8 by <a href="/users/1">mira_k</a> 1,204 · 3 · 11</div></div>
</div>
<div id="answers"><h2 class="answers-subheader">3 Answers</h2>
<div class="sort-tabs"><a href="?answertab=scoredesc">Highest score (default)</a> <a href="?answertab=trending">Trending</a> <a href="?answertab=modifieddesc">Date modified</a></div>
${answers
  .map(
    (a, i) => `<div class="answer${i === 0 ? ' accepted-answer' : ''} post-layout" id="answer-${i + 1}" data-answerid="${i + 1}">
<div class="votecell"><button aria-label="Up vote">▲</button><div class="js-vote-count">${[31, 9, 4][i]}</div><button aria-label="Down vote">▼</button>${i === 0 ? '<div class="accepted" aria-label="accepted">✓</div>' : ''}</div>
<div class="answercell"><div class="s-prose js-post-body">${a}</div><div class="post-menu"><a href="/a/${i + 1}/share">Share</a> <a href="/posts/${i + 1}/edit">Edit</a> <a href="#">Follow</a></div><div class="user-info">answered Jan 8 by <a href="/users/${i + 2}">user${i + 2}</a></div>
${i === 0 ? `<div class="comments"><ul>${comments.map((c, j) => `<li class="comment"><div class="comment-body"><span class="comment-copy">${c}</span> – <a href="/users/${j + 9}" class="comment-user">commenter${j}</a> <span class="comment-date">Jan 9</span></div></li>`).join('')}</ul><a class="js-add-link" href="#">Add a comment</a></div>` : ''}
</div></div>`,
  )
  .join('\n')}
</div>
<div class="post-form"><h2>Your Answer</h2><textarea></textarea><button>Post Your Answer</button><p>By clicking Post Your Answer you agree to our <a href="/terms">terms of service</a>.</p></div>
</div>
<div id="sidebar" class="sidebar"><div class="module"><h4>Linked</h4><ul><li><a href="/questions/1">Sliding window vs fixed window</a></li><li><a href="/questions/2">Redis rate limiter race condition</a></li></ul></div><div class="module"><h4>Hot Network Questions HOT-NETWORK-MARKER</h4><ul><li><a href="/q/a">Why is my kettle humming</a></li><li><a href="/q/b">Etymology of "bucket"</a></li><li><a href="/q/c">Can a chess pawn move backwards</a></li></ul></div></div>
</div>
${siteFooter('Example Q&A')}`,
    }),
  });
}

// ─── 7. Forum thread (DiscussionForumPosting, .post list) ────────────────────
{
  const url = 'https://forum.example.org/t/parsers-recursive-descent-vs-pratt/9921';
  const posts = [
    { user: 'ada', text: `<p>Starting a thread on parser design. ${P.parserIntro}</p><p>${P.parserRecursive}</p>` },
    { user: 'brendan', text: `<p>${P.parserPratt} I switched our expression parser to this last year and deleted eleven grammar rules.</p>` },
    { user: 'chen', text: `<p>Neither approach helps if you ignore recovery. ${P.parserErrors}</p>` },
    { user: 'ada', text: `<p>Agreed on recovery. For what it is worth the Pratt loop composes fine with statement-level synchronisation.</p>` },
  ];
  const contentGold = `<h1>Parsers: recursive descent vs Pratt</h1>
${posts.map((p) => `<div class="post"><h3>${p.user}</h3>${p.text}</div>`).join('\n')}`;
  add({
    name: 'forum-thread',
    gold: contentGold,
    spec: {
      url,
      type: 'Discourse-like forum thread (DiscussionForumPosting) with 4 posts, avatars, like buttons, suggested topics',
      minF1: 0.75,
      mustContain: ['deleted eleven grammar rules', 'synchronise on statement boundaries', 'composes fine with statement-level'],
      mustNotContain: ['SUGGESTED-TOPICS-MARKER', 'FOOTER-MARKER-TEXT'],
    },
    html: page({
      title: 'Parsers: recursive descent vs Pratt - Compilers - Example Forum',
      head: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"DiscussionForumPosting","headline":"Parsers: recursive descent vs Pratt","datePublished":"2025-09-30T08:00:00Z","author":{"@type":"Person","name":"ada"},"interactionStatistic":{"@type":"InteractionCounter","userInteractionCount":4}}</script>`,
      body: `${siteHeader('Example Forum')}
<div id="main-outlet" class="wrap">
<div id="topic-title"><h1><a href="${url}">Parsers: recursive descent vs Pratt</a></h1><div class="topic-category"><a href="/c/compilers">Compilers</a> <a class="tag" href="/tag/parsing">parsing</a></div></div>
<div class="post-stream">
${posts
  .map(
    (p, i) => `<article class="topic-post post boxed" id="post_${i + 1}" data-post-id="${i + 1}">
<div class="topic-avatar"><img alt="" src="/avatars/${p.user}.png" width="45" height="45"></div>
<div class="topic-body"><div class="topic-meta-data"><span class="username"><a href="/u/${p.user}">${p.user}</a></span><span class="post-date"><a href="/t/9921/${i + 1}">Sep ${30 + i}, 2025</a></span></div>
<div class="cooked">${p.text}</div>
<div class="post-controls"><button class="like" aria-label="like this post">♥ ${3 - (i % 3)}</button><button class="share">Share</button><button class="reply">Reply</button><button class="bookmark">Bookmark</button></div>
</div></article>`,
  )
  .join('\n')}
</div>
<div class="topic-map"><span>created Sep 30, 2025</span> <span>last reply Oct 3, 2025</span> <span>4 replies</span> <span>212 views</span></div>
<div id="suggested-topics"><h3>Suggested Topics SUGGESTED-TOPICS-MARKER</h3><table><tr><td><a href="/t/1">Incremental parsing in editors</a></td><td>Compilers</td><td>7</td></tr><tr><td><a href="/t/2">Error messages people actually read</a></td><td>Compilers</td><td>12</td></tr><tr><td><a href="/t/3">Show HN: a Pratt parser in 100 lines</a></td><td>Show</td><td>3</td></tr></table></div>
</div>
${siteFooter('Example Forum')}`,
    }),
  });
}

// ─── 8. GitHub-like repository page (README inside heavy chrome) ─────────────
{
  const url = 'https://github.example.com/acme/limiter';
  const readme = `<h1>limiter</h1>
<p>A tiny, dependency-free rate limiter for Node.js and browsers.</p>
<h2>Install</h2>
<pre><code class="language-sh">npm install @acme/limiter</code></pre>
<h2>Usage</h2>
<pre><code class="language-js">import { tokenBucket } from '@acme/limiter';
const take = tokenBucket({ capacity: 20, refillPerSecond: 5 });
if (take()) sendRequest();</code></pre>
<h2>How it works</h2>
${para('tokenBucket', 'slidingWindow')}
<h2>License</h2>
<p>MIT</p>`;
  add({
    name: 'github-repo',
    gold: readme,
    spec: {
      url,
      type: 'GitHub-like repo landing page: global nav, file table, sidebar About/Releases, README article',
      minF1: 0.7,
      mustContain: ['npm install @acme/limiter', 'refillPerSecond: 5', 'dependency-free rate limiter'],
      mustNotContain: ['FILE-TABLE-MARKER', 'Skip to content', 'You signed in with another tab'],
      minCodeBlocks: 2,
    },
    html: page({
      title: 'GitHub - acme/limiter: A tiny, dependency-free rate limiter',
      head: `<meta property="og:type" content="object"><meta name="description" content="A tiny, dependency-free rate limiter for Node.js and browsers. - acme/limiter">`,
      body: `
<a href="#start-of-content" class="skip-to-content">Skip to content</a>
<header class="Header" role="banner"><nav aria-label="Global"><a href="/">Example Hub</a><a href="/pulls">Pull requests</a><a href="/issues">Issues</a><a href="/marketplace">Marketplace</a><a href="/explore">Explore</a></nav><input placeholder="Search or jump to..."><a href="/notifications">Notifications</a><a href="/new">New</a><a href="/settings/profile">Profile</a></header>
<div class="flash-notice hidden">You signed in with another tab or window. Reload to refresh your session.</div>
<div id="start-of-content"></div>
<div id="repository-container-header"><nav aria-label="Repository"><ul class="UnderlineNav-body"><li><a href="/acme/limiter">Code</a></li><li><a href="/acme/limiter/issues">Issues 4</a></li><li><a href="/acme/limiter/pulls">Pull requests 1</a></li><li><a href="/acme/limiter/actions">Actions</a></li><li><a href="/acme/limiter/security">Security</a></li><li><a href="/acme/limiter/pulse">Insights</a></li></ul></nav><div class="repo-actions"><button>Watch 12</button><button>Fork 3</button><button>Star 241</button></div></div>
<div class="Layout">
<div class="Layout-main">
<div class="file-navigation"><button>main</button><span>3 branches</span><span>8 tags</span><a href="/acme/limiter/find/main">Go to file</a><button>Code</button></div>
<div class="Box"><div class="Box-header">acme committed <a href="/acme/limiter/commit/abc">Bump to 1.4.2</a> · 2 weeks ago · <a href="/acme/limiter/commits/main">148 commits</a></div>
<table aria-labelledby="files" class="files"><tbody>
<tr><td><a href="/acme/limiter/tree/main/.github/workflows">.github/workflows FILE-TABLE-MARKER</a></td><td>ci: node 24</td><td>3 weeks ago</td></tr>
<tr><td><a href="/acme/limiter/tree/main/src">src</a></td><td>fix: refill on first call</td><td>2 weeks ago</td></tr>
<tr><td><a href="/acme/limiter/tree/main/test">test</a></td><td>test: burst after idle</td><td>2 weeks ago</td></tr>
<tr><td><a href="/acme/limiter/blob/main/.gitignore">.gitignore</a></td><td>init</td><td>2 years ago</td></tr>
<tr><td><a href="/acme/limiter/blob/main/LICENSE">LICENSE</a></td><td>init</td><td>2 years ago</td></tr>
<tr><td><a href="/acme/limiter/blob/main/README.md">README.md</a></td><td>docs: usage</td><td>1 month ago</td></tr>
<tr><td><a href="/acme/limiter/blob/main/package.json">package.json</a></td><td>Bump to 1.4.2</td><td>2 weeks ago</td></tr>
</tbody></table></div>
<div id="readme" class="Box md"><div class="Box-header"><h2 class="Box-title">README.md</h2><a href="/acme/limiter/edit/main/README.md">Edit</a></div>
<article class="markdown-body entry-content container-lg">
${readme}
</article></div>
</div>
<div class="Layout-sidebar"><div class="BorderGrid"><div class="BorderGrid-cell"><h2>About</h2><p>A tiny, dependency-free rate limiter for Node.js and browsers.</p><a href="/topics/rate-limiting">rate-limiting</a> <a href="/topics/nodejs">nodejs</a><div><a href="/acme/limiter/blob/main/LICENSE">MIT license</a></div><div>241 stars · 12 watching · 3 forks</div></div><div class="BorderGrid-cell"><h2>Releases 8</h2><a href="/acme/limiter/releases/tag/v1.4.2">v1.4.2 Latest</a></div><div class="BorderGrid-cell"><h2>Packages</h2>No packages published</div><div class="BorderGrid-cell"><h2>Languages</h2><span>TypeScript 96.1%</span><span>JavaScript 3.9%</span></div></div></div>
</div>
<footer class="footer" role="contentinfo"><ul><li>© 2026 Example Hub, Inc.</li><li><a href="/terms">Terms</a></li><li><a href="/privacy">Privacy</a></li><li><a href="/security">Security</a></li><li><a href="/status">Status</a></li><li><a href="/docs">Docs</a></li><li><a href="/contact">Contact</a></li></ul> FOOTER-MARKER-TEXT</footer>`,
    }),
  });
}

// ─── 9. arXiv HTML (LaTeXML) ─────────────────────────────────────────────────
{
  const url = 'https://arxiv.example.org/html/2601.01234v2';
  const contentGold = `<h1>Adaptive Token Buckets for Multi-Tenant APIs</h1>
<p>Nadia Okafor, Tomasz Wiśniewski</p>
<h2>Abstract</h2>
<p>We study rate limiting for multi-tenant APIs where tenants have heterogeneous burst profiles. We propose an adaptive token bucket whose refill rate is adjusted from observed demand and show that it reduces spurious rejections by 37% on production traces without increasing p99 latency.</p>
<h2>1 Introduction</h2>
${para('intro', 'tokenBucket')}
<h2>2 Method</h2>
<p>Let <math alttext="r_t"><mi>r</mi></math> denote the refill rate at time t. We update it as <math alttext="r_{t+1} = r_t + \\eta (d_t - r_t)"><mi>r</mi></math> where d is the smoothed demand and η the learning rate.</p>
${para('distributed')}
<h2>3 Results</h2>
<table><thead><tr><th>Policy</th><th>Rejections</th><th>p99 latency (ms)</th></tr></thead><tbody><tr><td>Fixed bucket</td><td>4.1%</td><td>212</td></tr><tr><td>Adaptive bucket</td><td>2.6%</td><td>209</td></tr></tbody></table>
<h2>References</h2>
<ol><li>R. Fielding et al. Hypertext Transfer Protocol (HTTP/1.1): Semantics and Content. RFC 7231, 2014.</li><li>M. Nottingham. RateLimit header fields for HTTP. Internet-Draft, 2024.</li></ol>`;
  add({
    name: 'arxiv-html',
    gold: contentGold,
    spec: {
      url,
      type: 'arXiv HTML (LaTeXML): ltx_page_main, abstract, sections, math alttext, results table, references, TOC nav',
      minF1: 0.8,
      mustContain: ['reduces spurious rejections by 37%', 'Adaptive bucket', 'RFC 7231'],
      mustNotContain: ['ARXIV-TOC-MARKER', 'Report issue for preceding element'],
      minTableRows: 2,
    },
    html: page({
      title: 'Adaptive Token Buckets for Multi-Tenant APIs',
      head: `<meta name="citation_title" content="Adaptive Token Buckets for Multi-Tenant APIs"><meta name="citation_author" content="Okafor, Nadia"><meta name="citation_date" content="2026-01-05">`,
      body: `
<div class="ltx_page_navbar"><nav class="ltx_TOC"><ol class="ltx_toclist"><li><a href="#S1">1 Introduction ARXIV-TOC-MARKER</a></li><li><a href="#S2">2 Method</a></li><li><a href="#S3">3 Results</a></li></ol></nav></div>
<div class="ltx_page_main"><div class="ltx_page_content"><article class="ltx_document ltx_authors_1line">
<h1 class="ltx_title ltx_title_document">Adaptive Token Buckets for Multi-Tenant APIs</h1>
<div class="ltx_authors"><span class="ltx_creator ltx_role_author"><span class="ltx_personname">Nadia Okafor, Tomasz Wiśniewski</span></span></div>
<div class="ltx_abstract"><h6 class="ltx_title ltx_title_abstract">Abstract</h6><p class="ltx_p">We study rate limiting for multi-tenant APIs where tenants have heterogeneous burst profiles. We propose an adaptive token bucket whose refill rate is adjusted from observed demand and show that it reduces spurious rejections by 37% on production traces without increasing p99 latency.</p></div>
<section id="S1" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">1 </span>Introduction</h2><div class="ltx_para"><p class="ltx_p">${P.intro}</p><p class="ltx_p">${P.tokenBucket}</p></div><div class="ltx_pagination ltx_role_newpage"></div><button class="sr-only">Report issue for preceding element</button></section>
<section id="S2" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">2 </span>Method</h2><div class="ltx_para"><p class="ltx_p">Let <math alttext="r_t" class="ltx_Math"><semantics><mi>r</mi></semantics></math> denote the refill rate at time t. We update it as <math alttext="r_{t+1} = r_t + \\eta (d_t - r_t)" class="ltx_Math"><semantics><mi>r</mi></semantics></math> where d is the smoothed demand and η the learning rate.</p><p class="ltx_p">${P.distributed}</p></div><button class="sr-only">Report issue for preceding element</button></section>
<section id="S3" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">3 </span>Results</h2><figure class="ltx_table"><figcaption>Table 1: Rejection rate and latency.</figcaption><table class="ltx_tabular"><thead><tr><th>Policy</th><th>Rejections</th><th>p99 latency (ms)</th></tr></thead><tbody><tr><td>Fixed bucket</td><td>4.1%</td><td>212</td></tr><tr><td>Adaptive bucket</td><td>2.6%</td><td>209</td></tr></tbody></table></figure></section>
<section class="ltx_bibliography"><h2 class="ltx_title ltx_title_bibliography">References</h2><ul class="ltx_biblist"><li class="ltx_bibitem"><span class="ltx_tag">[1]</span> R. Fielding et al. Hypertext Transfer Protocol (HTTP/1.1): Semantics and Content. RFC 7231, 2014.</li><li class="ltx_bibitem"><span class="ltx_tag">[2]</span> M. Nottingham. RateLimit header fields for HTTP. Internet-Draft, 2024.</li></ul></section>
</article></div>
<footer class="ltx_page_footer"><div class="ltx_page_logo">Generated by <a href="https://math.nist.gov/~BMiller/LaTeXML/">LaTeXML</a></div><div class="keyboard-glossary hidden"><h2>Instructions for reporting errors</h2><p>Use Alt+Y to toggle on accessible reporting links.</p></div></footer></div>`,
    }),
  });
}

// ─── 10–13. JS shells ────────────────────────────────────────────────────────
const bigBlob = (seed: string, kb: number) => {
  let s = '';
  let i = 0;
  while (s.length < kb * 1024) s += `"${seed}${i++}":{"id":${i},"v":"${'x'.repeat(40)}"},`;
  return s;
};
add({
  name: 'js-shell-react',
  spec: {
    url: 'https://app.example.com/dashboard',
    type: 'CRA/Vite React shell: empty #root, noscript enable-JS, large bundle reference',
    failure: 'PARSE_NEEDS_JS',
  },
  html: page({
    title: 'Example App',
    head: `<link rel="manifest" href="/manifest.json"><script type="module" crossorigin src="/assets/index-Ck2p9x.js"></script><link rel="stylesheet" href="/assets/index-B1x.css">`,
    body: `<noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div><script>window.__APP_CONFIG__={${bigBlob('cfg', 20)}"env":"prod"};</script>`,
  }),
});
add({
  name: 'js-shell-next-app',
  spec: {
    url: 'https://shop.example.com/products/limiter-pro',
    type: 'Next.js App Router shell: header only, empty content, many self.__next_f.push RSC chunks',
    failure: 'PARSE_NEEDS_JS',
  },
  html: page({
    title: 'Limiter Pro',
    head: `<link rel="preload" as="script" href="/_next/static/chunks/webpack-1a2b.js"><script src="/_next/static/chunks/main-app.js" async=""></script>`,
    body: `<div hidden id="S:0"></div><header><nav><a href="/">Shop</a><a href="/cart">Cart (0)</a></nav></header><div id="__next"><main class="min-h-screen"><template id="B:0"></template><!--$?--><div class="skeleton" aria-busy="true"></div><!--/$--></main></div>
<script>(self.__next_f=self.__next_f||[]).push([0])</script>
<script>self.__next_f.push([1,"1:HL[\\"/_next/static/css/app.css\\",\\"style\\"]\\n0:\\"$L2\\"\\n"])</script>
<script>self.__next_f.push([1,"2:I[\\"(app-pages-browser)/./app/layout.tsx\\",[\\"app/layout\\",\\"static/chunks/app/layout.js\\"],\\"default\\"]\\n${bigBlob('n', 24).replace(/"/g, '\\"')}"])</script>
<script>self.__next_f.push([1,"3:[\\"$\\",\\"$L4\\",null,{\\"children\\":\\"$L5\\"}]\\n"])</script>`,
  }),
});
add({
  name: 'js-shell-nuxt',
  spec: {
    url: 'https://nuxt.example.com/blog',
    type: 'Nuxt 3 SPA shell: empty #__nuxt, __NUXT_DATA__ payload script',
    failure: 'PARSE_NEEDS_JS',
  },
  html: page({
    title: 'Blog · Example',
    body: `<div id="__nuxt"></div><script type="application/json" id="__NUXT_DATA__" data-ssr="false">[["Reactive",1],{"data":2,"state":3,"once":4},{},{},[],${bigBlob('p', 18)}]</script><script type="module" src="/_nuxt/entry.js" crossorigin></script>`,
  }),
});
add({
  name: 'js-shell-angular',
  spec: {
    url: 'https://ng.example.com/',
    type: 'Angular shell: <app-root> with ng-version and a Loading… placeholder',
    failure: 'PARSE_NEEDS_JS',
  },
  html: page({
    title: 'ExampleNg',
    head: `<base href="/"><link rel="icon" href="favicon.ico">`,
    body: `<app-root ng-version="18.2.0"><div class="app-loading">Loading…</div></app-root><script src="runtime.3f2a.js" type="module"></script><script src="polyfills.7c1.js" type="module"></script><script src="main.9d0e.js" type="module"></script>`,
  }),
});

// ─── 14. Next.js SSR (content present + huge __NEXT_DATA__) ─────────────────
{
  const url = 'https://ssr.example.com/blog/parsers';
  const contentGold = `<h1>Two ways to parse expressions</h1>
${para('parserIntro', 'parserRecursive')}
<h2>Pratt parsing</h2>
${para('parserPratt')}
<h2>Recovering from errors</h2>
${para('parserErrors')}`;
  add({
    name: 'next-ssr',
    gold: contentGold,
    spec: {
      url,
      type: 'Next.js Pages Router SSR page: full content in DOM plus a 60 KB __NEXT_DATA__ script that must not be mistaken for a shell',
      minF1: 0.9,
      mustContain: ['binding power', 'synchronise on statement boundaries'],
      mustNotContain: ['NEXT-DATA-MARKER', 'FOOTER-MARKER-TEXT'],
    },
    html: page({
      title: 'Two ways to parse expressions – SSR Example',
      head: `<meta property="og:type" content="article"><meta property="article:published_time" content="2026-05-20T00:00:00Z">`,
      body: `<div id="__next">${siteHeader('SSR Example')}<main><article>${contentGold}</article></main>${siteFooter('SSR Example')}</div>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"post":{"slug":"parsers","title":"Two ways to parse expressions","body":"NEXT-DATA-MARKER"},"nav":[${bigBlob('n', 60)}{"x":1}]}},"page":"/blog/[slug]","query":{"slug":"parsers"},"buildId":"k9s8d7f6","isFallback":false,"gssp":true,"scriptLoader":[]}</script>
<script src="/_next/static/chunks/webpack-8fa1.js" defer></script><script src="/_next/static/chunks/main-3b2c.js" defer></script>`,
    }),
  });
}

// ─── 15. Next.js data recovery (thin DOM, content only in __NEXT_DATA__) ─────
{
  const url = 'https://ssr.example.com/blog/parsers-client';
  const body = `<p>${P.parserIntro}</p><p>${P.parserRecursive}</p><h2>Pratt parsing</h2><p>${P.parserPratt}</p><h2>Recovering from errors</h2><p>${P.parserErrors}</p>`;
  add({
    name: 'next-data-recovery',
    gold: `<h1>Two ways to parse expressions</h1>${body}`,
    spec: {
      expectFail: 'script-blob __NEXT_DATA__ recovery',
      url,
      type: 'Next.js page whose DOM holds only a title/skeleton while __NEXT_DATA__ carries the article HTML in a `content` field',
      minF1: 0.6,
      mustContain: ['binding power', 'synchronise on statement boundaries'],
      mustNotContain: ['FOOTER-MARKER-TEXT'],
    },
    html: page({
      title: 'Two ways to parse expressions – SSR Example',
      body: `<div id="__next">${siteHeader('SSR Example')}<main><h1>Two ways to parse expressions</h1><div class="post-skeleton" aria-busy="true"><div class="line"></div><div class="line"></div></div></main>${siteFooter('SSR Example')}</div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: {
          pageProps: {
            post: { slug: 'parsers-client', title: 'Two ways to parse expressions', content: body, tags: ['parsing'] },
            related: [{ title: 'x', excerpt: 'short' }],
          },
        },
        page: '/blog/[slug]',
        query: { slug: 'parsers-client' },
        buildId: 'k9s8d7f6',
      })}</script>`,
    }),
  });
}

// ─── 16. Cookie wall over real content ───────────────────────────────────────
{
  const url = 'https://media.example.co.uk/tech/http-caching';
  const contentGold = `<h1>Why your CDN keeps serving stale pages</h1>
${para('cachingIntro', 'cachingMaxAge', 'cachingRevalidate', 'cachingVary')}`;
  add({
    name: 'cookie-wall',
    gold: contentGold,
    spec: {
      url,
      type: 'article behind a full-screen cookie/consent overlay (fixed div with long legal text) plus content underneath',
      minF1: 0.85,
      mustContain: ['s-maxage', 'Accept-Encoding'],
      mustNotContain: ['COOKIE-WALL-MARKER', 'legitimate interest', 'FOOTER-MARKER-TEXT'],
    },
    html: page({
      title: 'Why your CDN keeps serving stale pages | Example Media',
      head: `<meta property="og:type" content="article">`,
      body: `
<div id="qc-cmp2-container" class="consent-overlay" style="position:fixed;inset:0;z-index:9999"><div class="qc-cmp2-summary-section" role="dialog" aria-modal="true"><h2>We value your privacy COOKIE-WALL-MARKER</h2><p>We and our 843 partners store and/or access information on a device, such as cookies and process personal data, such as unique identifiers and standard information sent by a device for personalised advertising and content, advertising and content measurement, audience research and services development. With your permission we and our partners may use precise geolocation data and identification through device scanning. You may click to consent to our and our partners' processing as described above. Alternatively you may click to refuse to consent or access more detailed information and change your preferences before consenting. Please note that some processing of your personal data may not require your consent, but you have a right to object to such processing. Your preferences will apply to this website only. You can change your preferences or withdraw your consent at any time by returning to this site and clicking the Privacy button at the bottom of the webpage. Some partners do not ask for your consent to process your data and rely on their legitimate interest.</p><button>Agree</button><button>More options</button><button>Disagree</button></div></div>
${siteHeader('Example Media')}
<main><article>${contentGold}</article>${relatedAside()}</main>
${siteFooter('Example Media')}`,
    }),
  });
}

// ─── 17. Paywall (isAccessibleForFree:false, articleBody in JSON-LD) ─────────
{
  const url = 'https://paper.example.com/2026/06/01/inside-the-rate-limiter';
  const teaser = `<h1>Inside the rate limiter that runs the world's busiest API</h1>
<p>When the traffic doubled overnight, one small algorithm kept the lights on. This is the story of how it was built, and of the engineer who nearly deleted it. TEASER-VISIBLE-MARKER</p>`;
  add({
    name: 'paywall-jsonld',
    gold: teaser,
    spec: {
      url,
      type: 'paywalled article: DOM shows a teaser + subscribe wall; JSON-LD has isAccessibleForFree:false and the full articleBody (must never be used)',
      minF1: 0.6,
      mustContain: ['TEASER-VISIBLE-MARKER'],
      mustNotContain: ['PAYWALLED-BODY-MARKER', 'FOOTER-MARKER-TEXT'],
      meta: { accessibleForFree: false, kind: 'news' },
    },
    html: page({
      title: 'Inside the rate limiter that runs the world’s busiest API',
      head: `<meta property="og:type" content="article"><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Inside the rate limiter that runs the world's busiest API","datePublished":"2026-06-01T05:00:00Z","isAccessibleForFree":false,"hasPart":{"@type":"WebPageElement","isAccessibleForFree":false,"cssSelector":".paywall"},"articleBody":"PAYWALLED-BODY-MARKER ${P.intro} ${P.tokenBucket} ${P.leakyBucket} ${P.slidingWindow} ${P.headers} ${P.distributed} ${P.conclusion}"}</script>`,
      body: `${siteHeader('The Example Paper')}
<main><article>${teaser}<div class="paywall"><h2>Subscribe to keep reading</h2><p>Get unlimited access to every story. Cancel anytime.</p><a class="btn" href="/subscribe">Subscribe for $1/week</a> <a href="/login">Already a subscriber? Log in</a></div></article></main>
${siteFooter('The Example Paper')}`,
    }),
  });
}

// ─── 18. JSON-LD articleBody recovery (free) ─────────────────────────────────
{
  const url = 'https://amp.example.com/story/leaky-buckets';
  const bodyText = `${P.intro} ${P.leakyBucket} ${P.tokenBucket} ${P.conclusion}`;
  add({
    name: 'jsonld-articlebody-free',
    gold: `<h1>Leaky buckets, gently</h1><p>${bodyText}</p>`,
    spec: {
      expectFail: 'JSON-LD articleBody recovery',
      url,
      type: 'thin DOM (title + broken lazy-load placeholders) with a free (isAccessibleForFree:true) Article whose articleBody holds the text',
      minF1: 0.6,
      mustContain: ['smooths traffic instead of tolerating bursts'],
      mustNotContain: ['FOOTER-MARKER-TEXT'],
    },
    html: page({
      title: 'Leaky buckets, gently',
      head: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Leaky buckets, gently","isAccessibleForFree":true,"datePublished":"2026-02-02","articleBody":${JSON.stringify(bodyText)}}</script>`,
      body: `${siteHeader('Example AMP')}<main><h1>Leaky buckets, gently</h1><div class="story-body" data-lazy="/api/story/leaky-buckets"><noscript>Loading story…</noscript></div></main>${siteFooter('Example AMP')}`,
    }),
  });
}

// ─── 19–22. Code-heavy pages ─────────────────────────────────────────────────
{
  const url = 'https://blog.example.dev/posts/token-bucket-in-go';
  const code1 = `package limiter

type Bucket struct {
    capacity float64
    tokens   float64
    refill   float64
}

func (b *Bucket) Take() bool {
    b.tokens = min(b.capacity, b.tokens+b.refill*elapsed())
    if b.tokens < 1 { return false }
    b.tokens--
    return true
}`;
  const code2 = `$ go test ./... -run TestBurst
ok      example.dev/limiter   0.012s`;
  const gold = `<h1>A token bucket in twenty lines of Go</h1>
${para('tokenBucket')}
<pre><code class="language-go">${code1}</code></pre>
<p>Run the burst test to see the idle credit being spent:</p>
<pre><code class="language-sh">${code2}</code></pre>
${para('conclusion')}`;
  const shiki = (code: string, lang: string) =>
    `<pre class="shiki github-dark" style="background-color:#24292e;color:#e1e4e8" tabindex="0" data-language="${lang}"><code>${code
      .split('\n')
      .map(
        (l) =>
          `<span class="line">${l
            .split(/(\s+)/)
            .map((t) => (t.trim() ? `<span style="color:#F97583">${t}</span>` : t))
            .join('')}</span>`,
      )
      .join('\n')}</code></pre>`;
  add({
    name: 'code-shiki',
    gold,
    spec: {
      url,
      type: 'blog post with Shiki-highlighted blocks (span.line soup, data-language on pre)',
      minF1: 0.85,
      mustContain: ['func (b *Bucket) Take() bool', 'go test ./... -run TestBurst', '```go'],
      minCodeBlocks: 2,
    },
    html: page({
      title: 'A token bucket in twenty lines of Go',
      head: `<meta property="og:type" content="article">`,
      body: `${siteHeader('Example Dev Blog')}<main><article><h1>A token bucket in twenty lines of Go</h1>${para('tokenBucket')}${shiki(code1, 'go')}<p>Run the burst test to see the idle credit being spent:</p>${shiki(code2, 'sh')}${para('conclusion')}</article></main>${siteFooter('Example Dev Blog')}`,
    }),
  });

  // hljs with a line-number table
  const url2 = 'https://wiki.example.net/snippets/sliding-window-redis';
  const lua = `local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < tonumber(ARGV[3]) then
  redis.call('ZADD', key, now, now)
  return 1
end
return 0`;
  const gold2 = `<h1>Sliding window rate limiter in Redis</h1>
${para('slidingWindow')}
<pre><code class="language-lua">${lua}</code></pre>
${para('distributed')}`;
  const lines = lua.split('\n');
  const hljsTable = `<div class="highlight-wrapper"><table class="highlighttable"><tbody><tr><td class="linenos"><div class="linenodiv"><pre>${lines
    .map((_l, i) => `<span class="normal">${i + 1}</span>`)
    .join('\n')}</pre></div></td><td class="code"><div class="highlight"><pre><code class="hljs language-lua">${lines
    .map((l) => l.replace(/(local|if|then|end|return)/g, '<span class="hljs-keyword">$1</span>'))
    .join('\n')}</code></pre></div></td></tr></tbody></table><button class="copy-to-clipboard" data-clipboard-target="#code">Copy to clipboard</button></div>`;
  add({
    name: 'code-hljs-linenumbers',
    gold: gold2,
    spec: {
      url: url2,
      type: 'wiki snippet page with highlight.js code in a two-column line-number table plus a copy button',
      minF1: 0.8,
      mustContain: ["redis.call('ZREMRANGEBYSCORE'", 'return 0'],
      mustNotContain: ['Copy to clipboard', '1 2 3 4 5'],
      minCodeBlocks: 1,
    },
    html: page({
      title: 'Sliding window rate limiter in Redis - Example Wiki',
      body: `${siteHeader('Example Wiki')}<div id="content"><h1 id="firstHeading">Sliding window rate limiter in Redis</h1><div id="bodyContent">${para('slidingWindow')}${hljsTable}${para('distributed')}</div></div>${siteFooter('Example Wiki')}`,
    }),
  });

  // codehilite + data-lang + lang-* class + prism line-numbers plugin
  const url3 = 'https://docs.example.io/recipes/retries';
  const py = `import time

def retry(fn, attempts=5, base=0.2):
    for i in range(attempts):
        try:
            return fn()
        except TransientError:
            time.sleep(base * 2 ** i)
    raise GaveUp()`;
  const gold3 = `<h1>Retries with exponential backoff</h1>
<p>Retrying too eagerly turns a brief outage into a thundering herd, so each attempt should wait longer than the last and add jitter so that clients do not synchronise.</p>
<pre><code class="language-python">${py}</code></pre>
<p>The same idea in a shell one-liner:</p>
<pre><code class="language-bash">for i in 1 2 3 4 5; do curl -fsS https://api.example.io/ && break; sleep $((RANDOM % (2 ** i))); done</code></pre>
<p>Combine retries with a rate limiter on the client so a retry storm cannot exceed the quota.</p>`;
  add({
    name: 'code-codehilite',
    gold: gold3,
    spec: {
      url: url3,
      type: 'MkDocs/codehilite page: div.codehilite > pre, pre[data-lang], code.lang-bash with Prism line-numbers rows',
      minF1: 0.85,
      mustContain: ['except TransientError', '```python', 'RANDOM % (2 ** i)'],
      mustNotContain: ['DOCS-NAV-MARKER'],
      minCodeBlocks: 2,
    },
    html: page({
      title: 'Retries with exponential backoff - Example Recipes',
      body: `<nav class="md-header" aria-label="Header"><a href="/">Example Recipes DOCS-NAV-MARKER</a><a href="/recipes">Recipes</a><a href="/reference">Reference</a></nav>
<div class="md-container"><nav class="md-nav md-nav--primary" aria-label="Navigation"><ul><li><a href="/recipes/retries">Retries</a></li><li><a href="/recipes/timeouts">Timeouts</a></li><li><a href="/recipes/bulkheads">Bulkheads</a></li></ul></nav>
<main class="md-main"><article class="md-content__inner md-typeset"><h1>Retries with exponential backoff</h1>
<p>Retrying too eagerly turns a brief outage into a thundering herd, so each attempt should wait longer than the last and add jitter so that clients do not synchronise.</p>
<div class="codehilite"><pre><span></span><code class="language-python">${py.replace(/(import|def|for|in|try|return|except|raise)/g, '<span class="k">$1</span>')}
</code></pre></div>
<p>The same idea in a shell one-liner:</p>
<pre data-lang="bash" class="line-numbers"><code class="lang-bash">for i in 1 2 3 4 5; do curl -fsS https://api.example.io/ &amp;&amp; break; sleep $((RANDOM % (2 ** i))); done<span aria-hidden="true" class="line-numbers-rows"><span></span></span></code></pre>
<p>Combine retries with a rate limiter on the client so a retry storm cannot exceed the quota.</p>
</article></main></div>`,
    }),
  });
}

// ─── 23. Data-table page (short prose, big tables) ───────────────────────────
{
  const url = 'https://compare.example.com/rate-limiters';
  const rows = [
    ['nginx limit_req', 'leaky bucket', 'yes', 'zone size'],
    ['Envoy local ratelimit', 'token bucket', 'yes', 'tokens_per_fill'],
    ['Cloudflare Rate Limiting', 'sliding window', 'no', 'period'],
    ['Redis cell', 'GCRA', 'yes', 'burst'],
    ['Kong rate-limiting', 'fixed window', 'yes', 'policy'],
    ['Traefik RateLimit', 'token bucket', 'yes', 'burst'],
    ['Spring Bucket4j', 'token bucket', 'yes', 'bandwidth'],
    ['Guava RateLimiter', 'smooth bursty', 'no', 'permitsPerSecond'],
  ];
  const table = `<table><caption>Rate limiter implementations compared</caption><thead><tr><th>Implementation</th><th>Algorithm</th><th>Distributed</th><th>Main knob</th></tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
  const gold = `<h1>Rate limiter implementations compared</h1>
<p>The table below lists common implementations, the algorithm each uses and whether it can share state across instances.</p>
${table}
<p>Column "Main knob" names the option you will tune first.</p>`;
  add({
    name: 'data-tables',
    gold,
    spec: {
      url,
      type: 'comparison page: little prose, one 8-row data table with caption; Readability tends to drop the table',
      minF1: 0.8,
      mustContain: ['Envoy local ratelimit', 'permitsPerSecond', 'GCRA'],
      minTableRows: 8,
    },
    html: page({
      title: 'Rate limiter implementations compared',
      body: `${siteHeader('Example Compare')}<main>${gold}</main>${siteFooter('Example Compare')}`,
    }),
  });
}

// ─── 24. <pre>-only page (old rfc-editor style) ──────────────────────────────
{
  const url = 'https://rfc.example.org/rfc/rfc9999.html';
  const pre1 = `Internet Engineering Task Force (IETF)                    N. Okafor, Ed.
Request for Comments: 9999                                Example Labs
Category: Standards Track                                    April 2026
ISSN: 2070-1721


              <span class="h1">The RateLimit Header Fields for HTTP</span>

Abstract

   This document defines the RateLimit-Limit, RateLimit-Remaining and
   RateLimit-Reset header fields for HTTP, allowing servers to publish
   current service limits and clients to shape their request policy
   accordingly.

<span class="h2"><a class="selflink" id="section-1" href="#section-1">1</a>.  Introduction</span>

   Rate limiting is a common technique for protecting services. Servers
   have historically used a variety of non-standard fields such as
   X-RateLimit-Limit; this document defines standard fields with well
   defined semantics.

<span class="h2"><a class="selflink" id="section-2" href="#section-2">2</a>.  Header Field Definitions</span>

<span class="h3"><a class="selflink" id="section-2.1" href="#section-2.1">2.1</a>.  RateLimit-Limit</span>

   The RateLimit-Limit field indicates the maximum number of requests
   the server is willing to accept from the client in the current
   window.

     RateLimit-Limit: 100



<span class="grey">Okafor                       Standards Track                    [Page 1]</span>`;
  const pre2 = `<span class="grey"><a href="./rfc9999">RFC 9999</a>                RateLimit Header Fields               April 2026</span>


<span class="h3"><a class="selflink" id="section-2.2" href="#section-2.2">2.2</a>.  RateLimit-Remaining</span>

   The RateLimit-Remaining field indicates the number of requests
   remaining in the current window. It MUST NOT be greater than
   RateLimit-Limit.

<span class="h3"><a class="selflink" id="section-2.3" href="#section-2.3">2.3</a>.  RateLimit-Reset</span>

   The RateLimit-Reset field indicates the number of seconds until the
   window resets. Clients SHOULD wait at least this long before
   retrying after a 429 response.

<span class="h2"><a class="selflink" id="section-3" href="#section-3">3</a>.  Security Considerations</span>

   Publishing limits reveals capacity information that an attacker could
   use to plan a denial of service; servers MAY publish reduced values.



<span class="grey">Okafor                       Standards Track                    [Page 2]</span>`;
  const strip = (s: string) => s.replace(/<[^>]+>/g, '');
  add({
    name: 'pre-only-rfc',
    gold: `<pre>${strip(pre1)}</pre><pre>${strip(pre2)}</pre>`,
    spec: {
      url,
      type: 'old rfc-editor .html: the whole document is a series of <pre> blocks with page-break markers; Readability returns nothing',
      minF1: 0.6,
      mustContain: ['RateLimit-Remaining field indicates', 'Security Considerations', 'MUST NOT be greater than'],
      minChars: 1200,
    },
    html: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>RFC 9999 - The RateLimit Header Fields for HTTP</title><meta name="citation_title" content="The RateLimit Header Fields for HTTP"></head><body>
<pre>${pre1}</pre>
<hr class='noprint'/><!--NewPage--><pre class='newpage'><span id="page-2" ></span>${pre2}</pre>
</body></html>`,
  });
}

// ─── 25. Product page (JSON-LD Product) ──────────────────────────────────────
{
  const url = 'https://shop.example.com/products/limiter-pro';
  const gold = `<h1>Limiter Pro edge appliance</h1>
<p>Limiter Pro is a rack-mounted appliance that enforces per-tenant token buckets at line rate. It terminates TLS, applies limits from a central policy store and exports RateLimit headers on every response.</p>
<h2>Specifications</h2>
<table><tbody><tr><th>Throughput</th><td>40 Gbit/s</td></tr><tr><th>Policies</th><td>up to 250,000 buckets</td></tr><tr><th>Sync</th><td>gossip, 50 ms convergence</td></tr><tr><th>Form factor</th><td>1U</td></tr></tbody></table>
<h2>What is in the box</h2>
<ul><li>Appliance</li><li>Two power cords</li><li>Rack rails</li><li>Quick start guide</li></ul>`;
  add({
    name: 'product-page',
    gold,
    spec: {
      url,
      type: 'e-commerce product page (JSON-LD Product with offers), price box, reviews widget, recommendations carousel',
      minF1: 0.6,
      mustContain: ['40 Gbit/s', 'gossip, 50 ms convergence'],
      mustNotContain: ['RECOMMENDED-MARKER', 'FOOTER-MARKER-TEXT'],
      minTableRows: 3,
      meta: { kind: 'product' },
    },
    html: page({
      title: 'Limiter Pro edge appliance – Example Shop',
      head: `<meta property="og:type" content="product"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Limiter Pro edge appliance","description":"Rack-mounted rate limiting appliance.","offers":{"@type":"Offer","price":"4999.00","priceCurrency":"USD","availability":"https://schema.org/InStock"},"aggregateRating":{"@type":"AggregateRating","ratingValue":"4.6","reviewCount":"38"}}</script>`,
      body: `${siteHeader('Example Shop')}<main class="product">
<div class="gallery"><img src="/img/limiter-pro-1.jpg" alt="Limiter Pro front"><img src="/img/limiter-pro-2.jpg" alt="Limiter Pro rear"></div>
<div class="buy-box"><h1>Limiter Pro edge appliance</h1><div class="rating">★★★★☆ 4.6 (38 reviews)</div><div class="price">$4,999.00</div><select><option>1U</option><option>2U bundle</option></select><button class="add-to-cart">Add to cart</button><p class="shipping">Free shipping · 30-day returns</p></div>
<section class="description">${gold.replace('<h1>Limiter Pro edge appliance</h1>\n', '')}</section>
<section class="reviews"><h2>Customer reviews</h2><div class="review"><span>★★★★★</span> <b>Great box</b> — Does what it says. <span>2 people found this helpful</span></div><div class="review"><span>★★★☆☆</span> <b>Loud fans</b> — Works but noisy.</div><button>Write a review</button></section>
<section class="recommendations"><h2>Customers also bought RECOMMENDED-MARKER</h2><ul><li><a href="/products/rack">19-inch rack</a> $899</li><li><a href="/products/psu">Spare PSU</a> $199</li><li><a href="/products/support">Gold support</a> $1,200/yr</li></ul></section>
</main>${siteFooter('Example Shop')}`,
    }),
  });
}

// ─── 26. Video page (og:type video) ──────────────────────────────────────────
add({
  name: 'video-page',
  gold: `<h1>Talk: Rate limiting at the edge</h1><p>Recorded at ExampleConf 2026. In this 40 minute talk we walk through the token bucket, the leaky bucket and sliding windows, and show how the RateLimit header fields let clients back off gracefully. Slides are linked below the player.</p><h2>Chapters</h2><ul><li>00:00 Introduction</li><li>05:12 Token buckets</li><li>18:40 Leaky buckets and smoothing</li><li>27:05 Sliding windows in Redis</li><li>34:30 Questions</li></ul>`,
  spec: {
    url: 'https://video.example.com/watch?v=abc123',
    type: 'video watch page (og:type video.other, VideoObject JSON-LD): player, description, chapters, comments, up-next rail',
    minF1: 0.6,
    mustContain: ['18:40 Leaky buckets and smoothing', 'Recorded at ExampleConf 2026'],
    mustNotContain: ['UP-NEXT-MARKER', 'FOOTER-MARKER-TEXT'],
    meta: { kind: 'video', publishedAt: '2026-04-10' },
  },
  html: page({
    title: 'Talk: Rate limiting at the edge - Example Video',
    head: `<meta property="og:type" content="video.other"><meta property="og:video" content="https://video.example.com/embed/abc123"><script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"Talk: Rate limiting at the edge","uploadDate":"2026-04-10","duration":"PT40M"}</script>`,
    body: `${siteHeader('Example Video')}<main><div id="player"><video controls poster="/thumbs/abc123.jpg"><source src="/media/abc123.mp4"></video></div>
<h1>Talk: Rate limiting at the edge</h1><div class="video-meta">12,304 views · <time datetime="2026-04-10">Apr 10, 2026</time> <button>Like 210</button><button>Share</button><button>Save</button></div>
<div class="description"><p>Recorded at ExampleConf 2026. In this 40 minute talk we walk through the token bucket, the leaky bucket and sliding windows, and show how the RateLimit header fields let clients back off gracefully. Slides are linked below the player.</p><h2>Chapters</h2><ul><li>00:00 Introduction</li><li>05:12 Token buckets</li><li>18:40 Leaky buckets and smoothing</li><li>27:05 Sliding windows in Redis</li><li>34:30 Questions</li></ul></div>
<section class="comments"><h3>14 Comments</h3><form><textarea placeholder="Add a comment..."></textarea><button>Comment</button></form><div class="comment"><b>viewer1</b> great talk</div><div class="comment"><b>viewer2</b> slides link is broken</div></section>
<aside class="up-next"><h3>Up next UP-NEXT-MARKER</h3><ul><li><a href="/watch?v=def">Circuit breakers in 10 minutes</a></li><li><a href="/watch?v=ghi">Idempotency keys</a></li><li><a href="/watch?v=jkl">HTTP caching deep dive</a></li></ul></aside></main>${siteFooter('Example Video')}`,
  }),
});

// ─── 27. Multilingual page (lang, hreflang, Content-Language meta) ───────────
{
  const url = 'https://www.example.de/blog/ratenbegrenzung';
  const gold = `<h1>Ratenbegrenzung verständlich erklärt</h1>
<p>Eine Ratenbegrenzung schützt einen Dienst davor, von zu vielen Anfragen in kurzer Zeit überlastet zu werden. Statt unter Last unvorhersehbar auszufallen, lehnt ein begrenzter Dienst überzählige Anfragen kontrolliert ab und teilt dem Client mit, wann er es erneut versuchen darf.</p>
<h2>Token-Bucket</h2>
<p>Der Token-Bucket-Algorithmus führt einen Zähler verfügbarer Token, der sich mit fester Rate bis zu einer Höchstkapazität auffüllt. Jede Anfrage verbraucht ein Token; ist der Eimer leer, wird die Anfrage abgelehnt. Weil sich Token im Leerlauf ansammeln, verträgt der Eimer kurze Lastspitzen, ohne die langfristige Durchschnittsrate zu überschreiten.</p>
<h2>Leaky-Bucket</h2>
<p>Ein Leaky-Bucket glättet den Verkehr, statt Spitzen zu tolerieren: Anfragen landen in einer Warteschlange, die mit konstanter Rate abfließt; kommen Anfragen bei voller Warteschlange an, werden sie verworfen.</p>`;
  add({
    name: 'i18n-german',
    gold,
    spec: {
      url,
      type: 'German article with html lang="de", hreflang alternates, Content-Language meta',
      minF1: 0.9,
      mustContain: ['Höchstkapazität', 'Leaky-Bucket glättet'],
      meta: { lang: 'de', canonicalUrl: url, kind: 'blog' },
    },
    html: page({
      lang: 'de',
      title: 'Ratenbegrenzung verständlich erklärt – Beispiel',
      head: `<meta http-equiv="content-language" content="de-DE"><link rel="canonical" href="${url}"><link rel="alternate" hreflang="en" href="https://www.example.com/blog/rate-limiting"><link rel="alternate" hreflang="fr" href="https://www.example.fr/blog/limitation-de-debit"><link rel="alternate" hreflang="x-default" href="https://www.example.com/blog/rate-limiting"><meta property="og:type" content="article">`,
      body: `${siteHeader('Beispiel')}<main><article>${gold}</article></main>${siteFooter('Beispiel')}`,
    }),
  });
}

// ─── 28. CJK page without lang attribute (script heuristic) ─────────────────
add({
  name: 'i18n-japanese-nolang',
  gold: `<h1>レート制限のしくみ</h1><p>レート制限は、短時間に大量のリクエストが集中してサービスが過負荷になるのを防ぐ仕組みです。負荷がかかったときに予測不能に失敗する代わりに、制限されたサービスは超過分のリクエストを制御された方法で拒否または遅延させ、いつ再試行してよいかをクライアントに伝えます。</p><h2>トークンバケット</h2><p>トークンバケットアルゴリズムは、利用可能なトークンのカウンターを保持し、一定の速度で最大容量まで補充します。各リクエストはトークンを一つ消費し、バケットが空のときはリクエストが拒否されます。アイドル中にトークンが蓄積されるため、長期的な平均レートを超えることなく短いバーストを許容できます。</p><h2>リーキーバケット</h2><p>リーキーバケットはバーストを許容する代わりにトラフィックを平滑化します。リクエストは一定の速度で排出されるキューに入り、キューが満杯のときに到着したリクエストは破棄されます。</p>`,
  spec: {
    url: 'https://tech.example.jp/articles/rate-limiting',
    type: 'Japanese article with no lang attribute; language must come from a Unicode-script heuristic',
    minF1: 0.85,
    mustContain: ['トークンバケット', 'リーキーバケット'],
    meta: { lang: 'ja' },
  },
  html: page({
    lang: '',
    title: 'レート制限のしくみ | Example Tech',
    head: `<meta property="og:type" content="article">`,
    body: `${siteHeader('Example Tech')}<main><article><h1>レート制限のしくみ</h1><p>レート制限は、短時間に大量のリクエストが集中してサービスが過負荷になるのを防ぐ仕組みです。負荷がかかったときに予測不能に失敗する代わりに、制限されたサービスは超過分のリクエストを制御された方法で拒否または遅延させ、いつ再試行してよいかをクライアントに伝えます。</p><h2>トークンバケット</h2><p>トークンバケットアルゴリズムは、利用可能なトークンのカウンターを保持し、一定の速度で最大容量まで補充します。各リクエストはトークンを一つ消費し、バケットが空のときはリクエストが拒否されます。アイドル中にトークンが蓄積されるため、長期的な平均レートを超えることなく短いバーストを許容できます。</p><h2>リーキーバケット</h2><p>リーキーバケットはバーストを許容する代わりにトラフィックを平滑化します。リクエストは一定の速度で排出されるキューに入り、キューが満杯のときに到着したリクエストは破棄されます。</p></article></main>${siteFooter('Example Tech')}`,
  }),
});

// ─── 29. Date only in URL + canonical/AMP ────────────────────────────────────
{
  const url = 'https://amp.example-news.com/amp/2024/07/09/leaky-bucket-outage';
  const gold = `<h1>A leaky bucket that leaked too little</h1>
${para('leakyBucket', 'headers')}
<p>The fix was a one-line change to the drain rate, deployed the same afternoon.</p>`;
  add({
    name: 'amp-canonical-urldate',
    gold,
    spec: {
      url,
      type: 'AMP mirror page: no date metadata (date only in the URL path), rel=canonical pointing at the desktop URL, og:url',
      minF1: 0.9,
      mustContain: ['one-line change to the drain rate'],
      meta: {
        canonicalUrl: 'https://www.example-news.com/2024/07/09/leaky-bucket-outage',
        publishedAt: '2024-07-09',
      },
    },
    html: `<!DOCTYPE html><html ⚡ lang="en"><head><meta charset="utf-8"><title>A leaky bucket that leaked too little</title><link rel="canonical" href="https://www.example-news.com/2024/07/09/leaky-bucket-outage"><meta property="og:url" content="https://www.example-news.com/2024/07/09/leaky-bucket-outage"><meta property="og:type" content="article"></head><body><amp-sidebar id="sidebar" layout="nodisplay"><ul><li><a href="/">Home</a></li><li><a href="/world">World</a></li></ul></amp-sidebar><header class="amp-header"><a href="/">Example News</a></header><main><article>${gold}</article></main><footer>© Example News FOOTER-MARKER-TEXT</footer></body></html>`,
  });
}

// ─── 30. Article with figures/images/captions and inline links ───────────────
{
  const url = 'https://eng.example.com/blog/2026/how-we-shed-load';
  const gold = `<h1>How we shed load without dropping customers</h1>
<p>Last quarter our ingestion tier saw a 6× spike in traffic when a partner replayed a week of events in an hour. This post explains the three mechanisms that kept the service up: <a href="/blog/2025/priority-queues">priority queues</a>, adaptive concurrency limits and a token bucket per tenant.</p>
<figure><img src="/img/spike.png" alt="Request rate spike graph"><figcaption>Figure 1: request rate during the replay.</figcaption></figure>
<h2>Adaptive concurrency</h2>
<p>Instead of a static connection limit we measure the gradient of latency against in-flight requests and shrink the limit when latency climbs faster than throughput. The estimator is a simplified version of the one described in <a href="https://example.com/papers/gradient">the gradient paper</a>.</p>
<h2>Per-tenant buckets</h2>
${para('tokenBucket', 'distributed')}
<h2>What we would do differently</h2>
<ul><li>Turn on the per-tenant limits before the incident rather than during it.</li><li>Alert on bucket exhaustion per tenant, not just on global error rate.</li><li>Document the Retry-After behaviour in the partner API guide.</li></ul>`;
  add({
    name: 'article-figures',
    gold,
    spec: {
      url,
      type: 'engineering blog post with figure/figcaption, inline links, list; author card and comments section after the article',
      minF1: 0.9,
      mustContain: ['6× spike', 'gradient of latency', 'Alert on bucket exhaustion'],
      mustNotContain: ['AUTHOR-CARD-MARKER', 'FOOTER-MARKER-TEXT'],
      meta: { publishedAt: '2026-01-21' },
    },
    html: page({
      title: 'How we shed load without dropping customers - Example Engineering',
      head: `<meta property="og:type" content="article"><meta property="og:title" content="How we shed load without dropping customers"><meta itemprop="datePublished" content="2026-01-21"><meta property="og:image" content="https://eng.example.com/img/spike.png">`,
      body: `${siteHeader('Example Engineering')}<main><article itemscope itemtype="https://schema.org/BlogPosting"><meta itemprop="datePublished" content="2026-01-21">${gold}<div class="author-card"><img src="/img/authors/kim.jpg" alt=""><p><b>Kim Reyes</b> is a staff engineer on the ingestion team. AUTHOR-CARD-MARKER</p><a href="/authors/kim">More posts by Kim</a></div><section id="comments"><h3>Comments</h3><p>Comments are closed.</p></section></article>${relatedAside()}</main>${siteFooter('Example Engineering')}`,
    }),
  });
}

// ─── 31. Login-wall / mostly-empty page (should be PARSE_EMPTY, not needs-JS) ─
add({
  name: 'login-wall',
  spec: {
    url: 'https://intranet.example.com/wiki/Runbook',
    type: 'server-rendered login form page with almost no text; must be PARSE_EMPTY, not PARSE_NEEDS_JS',
    failure: 'PARSE_EMPTY',
  },
  html: page({
    title: 'Sign in',
    body: `<main><form method="post" action="/login"><h1>Sign in</h1><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button>Sign in</button></form></main>`,
  }),
});

// ─── 32. Docs page with nested nav in <main> and long definition list ────────
{
  const url = 'https://nodeish.example.org/api/limiter.html';
  const gold = `<h1>Limiter</h1>
<p>Stability: 2 - Stable</p>
<p>The <code>node:limiter</code> module provides token bucket and leaky bucket primitives for shaping outbound traffic.</p>
<h2>Class: TokenBucket</h2>
<p>Added in: v24.3.0</p>
<h3>new TokenBucket(options)</h3>
<ul><li><code>options</code> {Object}<ul><li><code>capacity</code> {number} Maximum tokens. <strong>Default:</strong> <code>100</code>.</li><li><code>refillPerSecond</code> {number} Tokens added per second. <strong>Default:</strong> <code>10</code>.</li></ul></li></ul>
<h3>bucket.tryAcquire([tokens])</h3>
<ul><li><code>tokens</code> {number} <strong>Default:</strong> <code>1</code></li><li>Returns: {boolean}</li></ul>
<p>Consumes <code>tokens</code> if available and returns <code>true</code>; otherwise returns <code>false</code> immediately.</p>
<pre><code class="language-js">const { TokenBucket } = require('node:limiter');
const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1 });
console.log(bucket.tryAcquire()); // true</code></pre>
<h2>Class: LeakyBucket</h2>
${para('leakyBucket')}`;
  add({
    name: 'docs-nodejs-api',
    gold,
    spec: {
      url,
      type: 'Node.js-style API docs: column nav inside <main>-less layout, stability index, nested option lists, hljs code',
      minF1: 0.85,
      mustContain: ['bucket.tryAcquire([tokens])', 'refillPerSecond: 1', 'Stability: 2'],
      mustNotContain: ['NODE-NAV-MARKER', 'Print', 'Edit on GitHub'],
      minCodeBlocks: 1,
    },
    html: page({
      title: 'Limiter | Node-ish v24.3.0 Documentation',
      body: `<div id="content" class="clearfix">
<div id="column2" class="interior"><div id="intro" class="interior"><a href="/" title="Go back to the home page">Node-ish</a></div><ul><li><a class="nav-documentation" href="documentation.html">About this documentation NODE-NAV-MARKER</a></li><li><a class="nav-assert" href="assert.html">Assert</a></li><li><a class="nav-buffer" href="buffer.html">Buffer</a></li><li><a class="nav-limiter active" href="limiter.html">Limiter</a></li><li><a class="nav-path" href="path.html">Path</a></li><li><a class="nav-stream" href="stream.html">Stream</a></li></ul></div>
<div id="column1" data-id="limiter" class="interior">
<header class="header"><div class="header-container"><h1>Node-ish v24.3.0 documentation</h1><button class="theme-toggle-btn" aria-label="Toggle dark mode">☾</button></div><div id="gtoc"><ul><li class="pinned-header">Node-ish v24.3.0</li><li class="picker-header"><a href="#">Index</a></li><li class="picker-header"><a href="#">View on single page</a></li><li class="picker-header"><a href="#">Print</a></li><li class="picker-header"><a href="https://github.com/nodeish/node/edit/main/doc/api/limiter.md">Edit on GitHub</a></li></ul></div><hr></header>
<details id="toc" open><summary>Table of contents</summary><ul><li><a href="#limiter">Limiter</a><ul><li><a href="#class-tokenbucket">Class: TokenBucket</a></li><li><a href="#class-leakybucket">Class: LeakyBucket</a></li></ul></li></ul></details>
<div id="apicontent">
<h2>Limiter<span><a class="mark" href="#limiter" id="limiter">#</a></span></h2>
<div class="api_stability api_stability_2"><a href="documentation.html#stability-index">Stability: 2</a> - Stable</div>
<p><strong>Source Code:</strong> <a href="https://github.com/nodeish/node/blob/v24.3.0/lib/limiter.js">lib/limiter.js</a></p>
<p>The <code>node:limiter</code> module provides token bucket and leaky bucket primitives for shaping outbound traffic.</p>
<section><h3>Class: TokenBucket<span><a class="mark" href="#class-tokenbucket" id="class-tokenbucket">#</a></span></h3><div class="api_metadata"><span>Added in: v24.3.0</span></div>
<h4>new TokenBucket(options)<span><a class="mark" href="#new-tokenbucketoptions" id="new-tokenbucketoptions">#</a></span></h4>
<ul><li><code>options</code> {Object}<ul><li><code>capacity</code> {number} Maximum tokens. <strong>Default:</strong> <code>100</code>.</li><li><code>refillPerSecond</code> {number} Tokens added per second. <strong>Default:</strong> <code>10</code>.</li></ul></li></ul>
<h4>bucket.tryAcquire([tokens])<span><a class="mark" href="#buckettryacquiretokens" id="buckettryacquiretokens">#</a></span></h4>
<ul><li><code>tokens</code> {number} <strong>Default:</strong> <code>1</code></li><li>Returns: {boolean}</li></ul>
<p>Consumes <code>tokens</code> if available and returns <code>true</code>; otherwise returns <code>false</code> immediately.</p>
<pre><code class="language-js"><span class="hljs-keyword">const</span> { <span class="hljs-title class_">TokenBucket</span> } = <span class="hljs-built_in">require</span>(<span class="hljs-string">'node:limiter'</span>);
<span class="hljs-keyword">const</span> bucket = <span class="hljs-keyword">new</span> <span class="hljs-title class_">TokenBucket</span>({ <span class="hljs-attr">capacity</span>: <span class="hljs-number">5</span>, <span class="hljs-attr">refillPerSecond</span>: <span class="hljs-number">1</span> });
<span class="hljs-title function_">console</span>.<span class="hljs-title function_">log</span>(bucket.<span class="hljs-title function_">tryAcquire</span>()); <span class="hljs-comment">// true</span></code> <button class="copy-button">copy</button></pre>
</section>
<section><h3>Class: LeakyBucket<span><a class="mark" href="#class-leakybucket" id="class-leakybucket">#</a></span></h3>${para('leakyBucket')}</section>
</div></div></div>`,
    }),
  });
}

// ─── writers ────────────────────────────────────────────────────────────────

function tidy(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function writeSynthetic(): void {
  for (const f of fixtures) {
    writeFileSync(join(here, `${f.name}.html`), f.html);
    if (f.gold !== undefined) {
      const md = tidy(htmlToMarkdown(f.gold, { origin: new URL(f.spec.url).origin }));
      writeFileSync(join(here, `${f.name}.gold.md`), `${md}\n`);
    }
    writeFileSync(join(here, `${f.name}.json`), `${JSON.stringify(f.spec, null, 2)}\n`);
  }
  console.log(`wrote ${fixtures.length} synthetic fixtures`);
}

// Real recorded pages (bodies from eval/fixtures/http, scripts/styles already stripped there).
const REAL: { name: string; file: string; spec: Spec }[] = [
  {
    name: 'real-wikipedia-okapi-bm25',
    file: 'en.wikipedia.org__wiki-Okapi-BM25__3NBmCmnUkVOc.json',
    spec: {
      url: 'https://en.wikipedia.org/wiki/Okapi_BM25',
      type: 'real: Wikipedia article (infobox-less, math, references, navboxes)',
      minF1: 0.9,
      mustContain: ['ranking function', 'IDF'],
      mustNotContain: ['Jump to content', 'Retrieved from', 'Privacy policy'],
      minChars: 3000,
    },
  },
  {
    name: 'real-rfc7235',
    file: 'www.rfc-editor.org__rfc-rfc7235-html__6pFLGo--Com0.json',
    spec: {
      url: 'https://www.rfc-editor.org/rfc/rfc7235.html',
      type: 'real: rfc-editor legacy <pre>-only page without <html>/<body> (was PARSE_EMPTY)',
      minF1: 0.9,
      mustContain: ['WWW-Authenticate', 'Proxy-Authenticate', '401 (Unauthorized)'],
      minChars: 25000,
    },
  },
  {
    name: 'real-python-dataclasses',
    file: 'docs.python.org__3-library-dataclasses-html__N1MXVR5vXgl1.json',
    spec: {
      url: 'https://docs.python.org/3/library/dataclasses.html',
      type: 'real: Sphinx docs (docs.python.org)',
      minF1: 0.9,
      mustContain: ['@dataclass', 'field(', 'frozen'],
      mustNotContain: ['Quick search', 'Report a bug'],
      minCodeBlocks: 5,
      minChars: 10000,
    },
  },
  {
    name: 'real-nodejs-path',
    file: 'nodejs.org__api-path-html__ZMvaE9cbaANH.json',
    spec: {
      url: 'https://nodejs.org/api/path.html',
      type: 'real: Node.js API docs',
      minF1: 0.9,
      mustContain: ['path.basename', 'path.resolve', 'path.sep'],
      minCodeBlocks: 5,
      minChars: 8000,
    },
  },
  {
    name: 'real-sqlite-wal',
    file: 'www.sqlite.org__wal-html__40gWiwOD-aDG.json',
    spec: {
      url: 'https://www.sqlite.org/wal.html',
      type: 'real: sqlite.org classic HTML docs (tables of contents, no semantic tags)',
      minF1: 0.9,
      mustContain: ['checkpoint', 'wal_autocheckpoint', 'shared memory'],
      minChars: 8000,
    },
  },
  {
    name: 'real-pep-0008',
    file: 'peps.python.org__pep-0008__RH9OncGYHIaA.json',
    spec: {
      url: 'https://peps.python.org/pep-0008/',
      type: 'real: PEP page (Sphinx-based with header table and TOC)',
      minF1: 0.9,
      mustContain: ['Maximum Line Length', '79 characters', 'Imports'],
      minChars: 15000,
    },
  },
  {
    name: 'real-mdn-cache-control',
    file: 'developer.mozilla.org__en-US-docs-Web-HTTP-Reference-Headers-Cache-Control__1BnqrQuAjECu.json',
    spec: {
      url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control',
      type: 'real: MDN reference page (sidebar, breadcrumbs, tables, code)',
      minF1: 0.9,
      mustContain: ['max-age', 'no-store', 'stale-while-revalidate'],
      mustNotContain: ['Skip to main content'],
      minCodeBlocks: 5,
      minChars: 8000,
    },
  },
  {
    name: 'real-elastic-rrf',
    file: 'www.elastic.co__docs-reference-elasticsearch-rest-apis-reciprocal-rank-fusio__O7g8Zu14uHX4.json',
    spec: {
      url: 'https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion',
      type: 'real: Elastic docs served as text/markdown (frontmatter, admonition tags) — TextParser path',
      contentType: 'text/markdown',
      minF1: 0.9,
      mustContain: ['rank_constant', 'rank_window_size'],
      minCodeBlocks: 3,
      minChars: 4000,
    },
  },
  {
    name: 'real-arxiv-abs',
    file: 'arxiv.org__abs-1706-03762__Q44myyqf94V6.json',
    spec: {
      url: 'https://arxiv.org/abs/1706.03762',
      type: 'real: arXiv abstract page (short content, heavy chrome)',
      minF1: 0.85,
      mustContain: ['Transformer', 'attention'],
      mustNotContain: ['Bibliographic Explorer'],
      minChars: 800,
    },
  },
];

function writeReal(): void {
  const evalDir = join(here, '..', '..', '..', '..', '..', 'eval', 'fixtures', 'http');
  for (const r of REAL) {
    const fx = JSON.parse(readFileSync(join(evalDir, r.file), 'utf8'));
    const html =
      fx.bodyEncoding === 'gzip-base64'
        ? gunzipSync(Buffer.from(fx.body, 'base64')).toString('utf8')
        : fx.bodyEncoding === 'base64'
          ? Buffer.from(fx.body, 'base64').toString('utf8')
          : fx.body;
    writeFileSync(join(here, `${r.name}.html.gz`), gzipSync(html, { level: 9 }));
    writeFileSync(join(here, `${r.name}.json`), `${JSON.stringify(r.spec, null, 2)}\n`);
  }
  console.log(`wrote ${REAL.length} real fixtures`);
}

const args = new Set(process.argv.slice(2));
if (args.has('--real')) writeReal();
else writeSynthetic();
if (args.has('--list')) console.log(readdirSync(here).filter((f) => f.endsWith('.json')).join('\n'));
