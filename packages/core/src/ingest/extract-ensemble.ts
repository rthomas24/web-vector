/**
 * Extractor ensemble + page-type routing (Trafilatura-style cascade with arbitration).
 *
 * Readability is a precision-biased *article* extractor: benchmark work (WCXB 2026, Trafilatura's
 * evaluation) shows it collapses on forums (comment CSS classes read as boilerplate), docs
 * (sidebars win the candidate race, tables get cleaned away) and product/collection pages. Instead
 * of a new library, this module:
 *
 * 1. classifies the page (`qa` | `docs` | `pre` | `article`) from JSON-LD types, comment/answer
 *    density, docs layout (nav + main + code) and <pre> share;
 * 2. builds a "full" candidate: the whole document (or `<main>` for docs) converted with mdream
 *    after removing nav / aside / header / footer / forms / dialogs / cookie banners / share bars /
 *    "related" rails and other chrome selectors;
 * 3. for `article` pages runs Readability too and applies a recall guard: when Readability kept
 *    less than ~35 % of the text, or dropped most code blocks / table rows, the fuller candidate
 *    wins; otherwise Readability's precision wins.
 *
 * Pure functions over a linkedom document; the parser owns Readability itself.
 */
import { htmlToMarkdown } from 'mdream';
import type { PageMeta } from './extract-meta.js';
import { unwrapProsePre } from './extract-prepass.js';

export type PageType = 'article' | 'qa' | 'docs' | 'pre' | 'other';

export interface Candidate {
  name: string;
  markdown: string;
  /** Plain-ish text length (markdown syntax removed roughly). */
  textLen: number;
  /** Share of text that is link text (0..1). */
  linkDensity: number;
  headings: number;
  codeBlocks: number;
  tableRows: number;
  /** Cookie / subscribe / sign-in style phrases per 1 000 chars. */
  junkPer1k: number;
  score: number;
}

const QA_TYPES = new Set([
  'qapage',
  'question',
  'answer',
  'discussionforumposting',
  'comment',
  'socialmediaposting',
]);
const DOCS_TYPES = new Set(['techarticle', 'apireference']);

const QA_NODE_SELECTOR =
  '.answer,.answercell,.comment,.comment-body,.post,.post-body,.postcell,.topic-post,.cooked,.js-post-body,.s-prose,.reply,.message,.forum-post,[id^="post_"],[id^="post-"],[id^="answer-"],[id^="comment-"],[data-post-id],[data-answerid],[itemprop="suggestedAnswer"],[itemprop="acceptedAnswer"],[itemprop="comment"]';

const MAIN_SELECTOR =
  'main,[role="main"],#main-content,#main,.main-content,#content,.content,article,#bodyContent,.body,.md-content,.theme-doc-markdown,.markdown-body,#apicontent';

/**
 * Elements removed from the full-document candidate. Header/footer are handled separately so that
 * article headers (title, byline) survive.
 */
const CHROME_SELECTOR = [
  'nav',
  'aside',
  'form',
  'dialog',
  'menu',
  'amp-sidebar',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="search"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tablist"]',
  '[aria-hidden="true"]',
  '[hidden]',
  '.sidebar',
  '#sidebar',
  '.site-header',
  '.site-footer',
  '.navbar',
  '.breadcrumbs',
  '.breadcrumb',
  '.pagination-nav',
  '.pagination',
  '.toc',
  '.table-of-contents',
  '.tableOfContents',
  '#toc',
  '.theme-doc-toc-desktop',
  '.theme-doc-toc-mobile',
  '.theme-doc-sidebar-container',
  '.sphinxsidebar',
  '.related',
  '.related-posts',
  '.related-articles',
  '.recommendations',
  '.up-next',
  '.suggested-topics',
  '#suggested-topics',
  '.hot-network-questions',
  '.cookie-banner',
  '.cookie-consent',
  '.consent-overlay',
  '#cookie-consent',
  '#qc-cmp2-container',
  '#onetrust-consent-sdk',
  '.cc-window',
  '.gdpr',
  '.newsletter',
  '.subscribe',
  '.share',
  '.share-bar',
  '.sharing',
  '.social',
  '.social-share',
  '.ad',
  '.ads',
  '.advertisement',
  '.ad-slot',
  '.adsbygoogle',
  '.skip-link',
  '.skip-to-content',
  '.visually-hidden',
  '.sr-only',
  '.screen-reader-text',
  '.post-form',
  '.comment-form',
  '#respond',
  '.votecell',
  '.post-menu',
  '.post-controls',
  '.reactions',
  '.author-card',
  '.author-box',
  '.byline-share',
  '.tags',
  '.post-tags',
  '.post-taglist',
  '.footer-cols',
  '.copyright',
  '.flash',
  '.flash-notice',
  '.js-flash-container',
  '.Header',
  '.footer',
  '.header',
  '.masthead',
  '.top-bar',
  '.topbar',
  '.global-nav',
  '.mobile-nav',
  '.offcanvas',
  '.modal',
  '.popup',
  '.overlay',
  '.banner',
  '.promo',
  '.cta',
].join(',');

const JUNK_RE =
  /\b(cookies?|accept all|subscribe|newsletter|sign in|sign up|log in|login|create account|privacy policy|terms of (?:service|use)|all rights reserved|share this|advertisement|sponsored|related (?:articles|posts|stories)|read more|skip to (?:main )?content|manage preferences)\b/gi;

// ─── classification ──────────────────────────────────────────────────────────

export function classifyPageType(document: any, meta: PageMeta): PageType {
  const types = new Set(meta.jsonLdTypes);
  if ([...types].some((t) => QA_TYPES.has(t))) return 'qa';
  let body = 0;
  let preText = 0;
  try {
    body = (document.body?.textContent ?? '').length;
    for (const p of document.querySelectorAll('pre')) preText += (p.textContent ?? '').length;
  } catch {
    /* ignore */
  }
  if (body > 0 && preText / body >= 0.6 && preText > 1500) return 'pre';
  // Comment / answer density: several sizeable post-like nodes → forum or Q&A thread.
  try {
    let posts = 0;
    for (const el of document.querySelectorAll(QA_NODE_SELECTOR)) {
      if ((el.textContent ?? '').replace(/\s+/g, ' ').trim().length >= 80) posts++;
      if (posts >= 3) return 'qa';
    }
  } catch {
    /* ignore */
  }
  if ([...types].some((t) => DOCS_TYPES.has(t))) return 'docs';
  if (meta.kind === 'docs') return 'docs';
  try {
    const main = document.querySelector('main,[role="main"]');
    const nav = document.querySelector('nav,[role="navigation"],aside,.sidebar,#sidebar');
    const pres = document.querySelectorAll('pre').length;
    if (main && nav && pres >= 2) return 'docs';
  } catch {
    /* ignore */
  }
  return 'article';
}

// ─── candidates ──────────────────────────────────────────────────────────────

/** Rough plain text of markdown for scoring (mirrors parsers.markdownToText cheaply). */
function roughText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*\n?/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function candidateFrom(name: string, markdown: string): Candidate {
  const text = roughText(markdown);
  const textLen = text.length;
  let linkChars = 0;
  for (const m of markdown.matchAll(/\[([^\]]*)\]\([^)]*\)/g)) linkChars += (m[1] ?? '').length;
  const linkDensity = textLen ? Math.min(1, linkChars / textLen) : 0;
  const headings = (markdown.match(/^#{1,6}\s+\S/gm) ?? []).length;
  const codeBlocks = (markdown.match(/^```/gm) ?? []).length >> 1;
  const tableRows = (markdown.match(/^\|.*\|\s*$/gm) ?? []).filter(
    (l) => !/^\|\s*-{3,}/.test(l),
  ).length;
  const junk = (text.match(JUNK_RE) ?? []).length;
  const junkPer1k = textLen ? (junk * 1000) / textLen : 0;
  const c: Candidate = {
    name,
    markdown,
    textLen,
    linkDensity,
    headings,
    codeBlocks,
    tableRows,
    junkPer1k,
    score: 0,
  };
  c.score = scoreCandidate(c);
  return c;
}

/**
 * Length rewarded logarithmically, discounted by link density (navigation lists) and junk phrase
 * density (cookie / subscribe / sign-in chrome); structure (headings, code, tables) adds a little.
 */
export function scoreCandidate(c: Candidate): number {
  if (c.textLen === 0) return 0;
  const linkFactor = (1 - Math.min(c.linkDensity, 0.9)) ** 2;
  return (
    Math.log(1 + c.textLen) * linkFactor -
    Math.min(c.junkPer1k, 10) * 0.3 +
    Math.min(c.headings, 20) * 0.05 +
    (c.codeBlocks > 0 ? 0.3 : 0) +
    (c.tableRows > 0 ? 0.3 : 0)
  );
}

/** Absolutise href/src on a (cloned) document so mdream needs no `origin` prefixing. */
function absolutizeLinks(root: any, url: string): void {
  try {
    for (const a of root.querySelectorAll('a[href]')) {
      const href = String(a.getAttribute('href') ?? '');
      if (!href || /^(#|javascript:|mailto:|tel:|data:)/i.test(href)) continue;
      try {
        a.setAttribute('href', new URL(href, url).href);
      } catch {
        /* keep */
      }
    }
    for (const img of root.querySelectorAll('img[src]')) {
      const src = String(img.getAttribute('src') ?? '');
      if (!src || /^(data:|blob:)/i.test(src)) continue;
      try {
        img.setAttribute('src', new URL(src, url).href);
      } catch {
        /* keep */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Remove page chrome from a subtree; keeps <header>/<footer> that carry article content. */
export function removeChrome(root: any): void {
  for (const el of [...root.querySelectorAll(CHROME_SELECTOR)]) {
    if (!root.contains(el)) continue;
    // Never delete the element that *is* the content root or an ancestor of most of the text.
    if (el === root) continue;
    el.remove();
  }
  for (const el of [...root.querySelectorAll('header,footer')]) {
    if (el === root || !root.contains(el)) continue;
    const inArticle = !!el.closest?.('article,main,[role="main"]');
    if (!inArticle) {
      el.remove();
      continue;
    }
    // Inside the content root: keep only if it reads like content (a heading + prose, not links).
    const text = String(el.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    let linkText = 0;
    for (const a of el.querySelectorAll('a'))
      linkText += String(a.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim().length;
    const hasHeading = !!el.querySelector('h1,h2,h3');
    if (!(hasHeading || text.length > 200) || linkText / Math.max(1, text.length) > 0.5)
      el.remove();
  }
}

/**
 * Pick the content root for docs-style pages: the most specific main-ish container that still
 * holds most (≥ 60 %) of the text of the largest one — `.theme-doc-markdown` over `main`,
 * `#apicontent` over `#content` — so column navs that live inside the outer container fall away.
 */
export function findMainRoot(document: any): any | undefined {
  try {
    const bodyLen = (document.body?.textContent ?? '').length || 1;
    const cands: { el: any; len: number }[] = [];
    for (const el of document.querySelectorAll(MAIN_SELECTOR)) {
      const len = (el.textContent ?? '').length;
      if (len >= bodyLen * 0.25) cands.push({ el, len });
    }
    if (!cands.length) return undefined;
    const largest = Math.max(...cands.map((c) => c.len));
    let best = cands[0]!;
    for (const c of cands) if (c.len >= largest * 0.6 && c.len <= best.len) best = c;
    return best.el;
  } catch {
    return undefined;
  }
}

/**
 * Selectors that are unambiguous chrome on any page type; removed from the live document before
 * both Readability and the full candidate run (Readability has no notion of cookie walls,
 * recommendation rails or flash notices and happily scores them into the article).
 */
const OBVIOUS_CHROME_SELECTOR = [
  'dialog',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '.cookie-banner',
  '.cookie-consent',
  '.consent-overlay',
  '#cookie-consent',
  '#cookie-banner',
  '#qc-cmp2-container',
  '#onetrust-consent-sdk',
  '.cc-window',
  '.gdpr',
  '.skip-link',
  '.skip-to-content',
  '.ad-slot',
  '.adsbygoogle',
  '.advertisement',
  '.recommendations',
  '.related-posts',
  '.related-articles',
  '.up-next',
  '.suggested-topics',
  '#suggested-topics',
  '.hot-network-questions',
  '.share-bar',
  '.social-share',
  '.flash-notice',
  '.js-flash-container',
  '.newsletter',
  '.post-form',
  '.comment-form',
  '#respond',
].join(',');

export function stripObviousChrome(document: any): number {
  let n = 0;
  try {
    for (const el of [...document.querySelectorAll(OBVIOUS_CHROME_SELECTOR)]) {
      el.remove();
      n++;
    }
  } catch {
    /* ignore */
  }
  return n;
}

const ARTICLE_ROOT_SELECTOR =
  'article,[itemprop="articleBody"],.markdown-body,#readme,.post-content,.entry-content,.article-body,.article-content,.story-body';

/**
 * A single dominant <article>-like container (≥ 20 % of the body text, only one such element or
 * one clearly largest) converted on its own — the README on a repository page, the story body on
 * a news page whose Readability candidate swallowed a file table or a "most read" list.
 */
export function articleCandidate(document: any, opts: FullCandidateOptions): Candidate | undefined {
  try {
    const bodyLen = (document.body?.textContent ?? '').length || 1;
    const els = [...document.querySelectorAll(ARTICLE_ROOT_SELECTOR)].filter(
      (el: any) => !el.closest?.('nav,aside,footer,header'),
    );
    if (!els.length) return undefined;
    const sized = els
      .map((el: any) => ({ el, len: (el.textContent ?? '').length }))
      .sort((a, b) => b.len - a.len);
    const top = sized[0]!;
    if (top.len < bodyLen * 0.2) return undefined;
    // Nested article roots (article > .entry-content) count as one; siblings (a feed) don't.
    const others = sized.slice(1).filter((s) => !top.el.contains(s.el) && !s.el.contains(top.el));
    if (others.some((s) => s.len > top.len * 0.5)) return undefined;
    const clone = top.el.cloneNode(true);
    removeChrome(clone);
    absolutizeLinks(clone, opts.url);
    const md = opts.tidy(htmlToMarkdown(clone.outerHTML ?? ''));
    return candidateFrom('mdream-article', md);
  } catch {
    return undefined;
  }
}

export interface FullCandidateOptions {
  url: string;
  /** Convert only the main content container when one is found (docs pages). */
  mainOnly?: boolean;
  /** Unwrap prose-like <pre> blocks (old plain-text documents). */
  unwrapPre?: boolean;
  tidy: (md: string) => string;
}

/**
 * Whole-document (or main-container) conversion with chrome removed. Works on a clone; the
 * caller's document is untouched.
 */
export function fullCandidate(document: any, opts: FullCandidateOptions): Candidate | undefined {
  try {
    const clone = document.cloneNode(true);
    if (opts.unwrapPre) unwrapProsePre(clone);
    let root = opts.mainOnly ? findMainRoot(clone) : undefined;
    let name = root ? 'mdream-main' : 'mdream-full';
    if (!root) root = clone.body ?? clone.documentElement;
    if (!root) return undefined;
    removeChrome(root);
    if (opts.unwrapPre) name = 'mdream-pre';
    absolutizeLinks(root, opts.url);
    const html = root.outerHTML ?? '';
    if (!html) return undefined;
    const md = opts.tidy(htmlToMarkdown(html));
    return candidateFrom(name, md);
  } catch {
    return undefined;
  }
}

// ─── arbitration ─────────────────────────────────────────────────────────────

export interface ChooseInput {
  readability?: Candidate;
  full?: Candidate;
  /** Single dominant <article> container converted on its own (see `articleCandidate`). */
  article?: Candidate;
  minArticleChars: number;
}

export interface Choice {
  candidate: Candidate;
  /** Why a non-Readability candidate was preferred (undefined when Readability won). */
  guard?:
    | 'no-article'
    | 'thin-article'
    | 'text-recall'
    | 'code-recall'
    | 'table-recall'
    | 'link-density'
    | 'score';
}

/**
 * Recall guard: Readability wins unless it kept too little of the page (< 35 % of the text, or
 * most of the code blocks / table rows are gone) or produced less than `minArticleChars`.
 */
export function chooseCandidate(input: ChooseInput): Choice | undefined {
  const r = input.readability;
  const f = input.full;
  if (!r && !f) return undefined;
  if (!r) return { candidate: f as Candidate, guard: 'no-article' };
  if (!f) return { candidate: r };
  const fullUsable = f.textLen > r.textLen && f.linkDensity < 0.6;
  if (r.textLen < input.minArticleChars && fullUsable)
    return { candidate: f, guard: 'thin-article' };
  // Readability swallowed navigation / file tables / link lists around the page's one <article>:
  // the article boundary is the stronger signal when it holds most of the same text.
  const a = input.article;
  if (
    a &&
    a.textLen >= input.minArticleChars &&
    a.textLen >= r.textLen * 0.6 &&
    a.textLen <= r.textLen &&
    (r.linkDensity > a.linkDensity + 0.15 || r.tableRows - a.tableRows >= 4)
  )
    return { candidate: a, guard: 'link-density' };
  if (!fullUsable) return { candidate: r };
  if (r.textLen < 0.35 * f.textLen) return { candidate: f, guard: 'text-recall' };
  if (f.codeBlocks >= 2 && r.codeBlocks < 0.5 * f.codeBlocks)
    return { candidate: f, guard: 'code-recall' };
  if (f.tableRows >= 4 && r.tableRows < 0.5 * f.tableRows)
    return { candidate: f, guard: 'table-recall' };
  return { candidate: r };
}
