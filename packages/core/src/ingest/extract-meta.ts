/**
 * Ranking-grade page metadata from the <head>, JSON-LD, microdata and the URL: title, byline,
 * dates (published / modified), canonical URL, hreflang alternates, page kind, paywall flag,
 * language. Pure DOM reads (linkedom document) — call before the DOM is mutated.
 */
import { normalizeLangTag } from './extract-detect.js';

export type PageKind = 'article' | 'news' | 'blog' | 'qa' | 'docs' | 'product' | 'video' | 'other';

export interface PageMeta {
  title?: string;
  description?: string;
  siteName?: string;
  byline?: string;
  lang?: string;
  publishedAt?: string;
  updatedAt?: string;
  /** Absolute canonical URL from <link rel=canonical> / og:url when it passes sanity checks. */
  canonicalUrl?: string;
  /** hreflang alternates (absolute URLs). */
  alternates?: { lang: string; url: string }[];
  kind: PageKind;
  /** schema.org isAccessibleForFree (false = paywalled); undefined when not declared. */
  accessibleForFree?: boolean;
  /** JSON-LD articleBody of the main CreativeWork (may be text or HTML). */
  articleBody?: string;
  /** Flattened JSON-LD @type values (lower-case, without namespace) — used for page-type routing. */
  jsonLdTypes: string[];
  /** Site generator (sphinx, docusaurus, mkdocs, hugo, …) when declared. */
  generator?: string;
}

const ARTICLE_TYPES = new Set([
  'article',
  'newsarticle',
  'blogposting',
  'techarticle',
  'scholarlyarticle',
  'report',
  'analysisnewsarticle',
  'reportagenewsarticle',
  'reviewnewsarticle',
  'opinionnewsarticle',
  'backgroundnewsarticle',
  'liveblogposting',
  'socialmediaposting',
]);

export function extractMeta(document: any, url: string): PageMeta {
  const q = (sel: string, attr = 'content'): string | undefined => {
    try {
      const v = document.querySelector(sel)?.getAttribute(attr);
      const s = v ? String(v).trim() : '';
      return s || undefined;
    } catch {
      return undefined;
    }
  };
  const first = (...vals: (string | undefined)[]) => vals.find((v) => v);

  const meta: PageMeta = { kind: 'other', jsonLdTypes: [] };
  meta.title = first(
    q('meta[property="og:title"]'),
    q('meta[name="twitter:title"]'),
    q('meta[name="citation_title"]'),
    q('meta[name="dc.title"]'),
    q('meta[name="DC.title"]'),
  );
  meta.description = first(
    q('meta[name="description"]'),
    q('meta[property="og:description"]'),
    q('meta[name="twitter:description"]'),
  );
  meta.siteName = first(q('meta[property="og:site_name"]'), q('meta[name="application-name"]'));
  meta.byline = first(
    q('meta[name="author"]'),
    q('meta[property="article:author"]'),
    q('meta[name="citation_author"]'),
    q('meta[name="dc.creator"]'),
    q('meta[name="DC.creator"]'),
    q('meta[name="parsely-author"]'),
    q('meta[name="sailthru.author"]'),
  );
  meta.generator = q('meta[name="generator"]')?.toLowerCase();

  // ── dates ────────────────────────────────────────────────────────────────
  meta.publishedAt = first(
    q('meta[property="article:published_time"]'),
    q('meta[name="article:published_time"]'),
    q('meta[itemprop="datePublished"]'),
    q('meta[name="parsely-pub-date"]'),
    q('meta[name="date"]'),
    q('meta[name="pubdate"]'),
    q('meta[name="publishdate"]'),
    q('meta[name="publish_date"]'),
    q('meta[name="dc.date"]'),
    q('meta[name="DC.date"]'),
    q('meta[name="dc.date.issued"]'),
    q('meta[name="DC.date.issued"]'),
    q('meta[name="dcterms.created"]'),
    q('meta[name="dcterms.date"]'),
    q('meta[name="citation_publication_date"]'),
    q('meta[name="citation_date"]'),
    q('meta[name="citation_online_date"]'),
    q('meta[name="sailthru.date"]'),
    q('meta[property="og:article:published_time"]'),
    q('[itemprop="datePublished"][datetime]', 'datetime'),
    q('[itemprop="datePublished"][content]', 'content'),
    q('article time[pubdate][datetime]', 'datetime'),
    q('article time[datetime]', 'datetime'),
    q('main time[datetime]', 'datetime'),
    q('time[pubdate][datetime]', 'datetime'),
  );
  meta.updatedAt = first(
    q('meta[property="article:modified_time"]'),
    q('meta[name="article:modified_time"]'),
    q('meta[property="og:updated_time"]'),
    q('meta[itemprop="dateModified"]'),
    q('meta[name="last-modified"]'),
    q('meta[name="lastmod"]'),
    q('meta[name="dcterms.modified"]'),
    q('meta[name="dc.date.modified"]'),
    q('meta[name="DC.date.modified"]'),
    q('meta[name="revised"]'),
    q('[itemprop="dateModified"][datetime]', 'datetime'),
    q('[itemprop="dateModified"][content]', 'content'),
  );

  // ── canonical / alternates ───────────────────────────────────────────────
  meta.canonicalUrl = sanitizeCanonical(
    first(q('link[rel="canonical"]', 'href'), q('meta[property="og:url"]')),
    url,
  );
  try {
    const alts: { lang: string; url: string }[] = [];
    for (const l of document.querySelectorAll('link[rel="alternate"][hreflang][href]')) {
      const lang = String(l.getAttribute('hreflang') ?? '').trim();
      const href = absolutize(String(l.getAttribute('href') ?? ''), url);
      if (lang && href && alts.length < 50) alts.push({ lang, url: href });
    }
    if (alts.length) meta.alternates = alts;
  } catch {
    /* ignore */
  }

  // ── language ─────────────────────────────────────────────────────────────
  meta.lang = normalizeLangTag(
    first(
      document.documentElement?.getAttribute?.('lang'),
      document.documentElement?.getAttribute?.('xml:lang'),
      q('meta[http-equiv="content-language"]'),
      q('meta[http-equiv="Content-Language"]'),
      q('meta[name="language"]'),
      q('meta[name="dc.language"]'),
      q('meta[name="DC.language"]'),
      q('meta[property="og:locale"]'),
    ),
  );

  // ── JSON-LD ──────────────────────────────────────────────────────────────
  const nodes = jsonLdNodes(document);
  const types: string[] = [];
  let mainWork: any;
  for (const n of nodes) {
    for (const t of typesOf(n)) {
      types.push(t);
    }
    const nt = typesOf(n);
    if (!mainWork && nt.some((t) => ARTICLE_TYPES.has(t))) mainWork = n;
    // QAPage → mainEntity: Question; NewsArticle nested in WebPage.mainEntity, etc.
    if (n.mainEntity && typeof n.mainEntity === 'object') {
      for (const t of typesOf(n.mainEntity)) types.push(t);
      if (!mainWork && typesOf(n.mainEntity).some((t) => ARTICLE_TYPES.has(t)))
        mainWork = n.mainEntity;
    }
    if (n.mainEntityOfPage && typeof n.mainEntityOfPage === 'object')
      for (const t of typesOf(n.mainEntityOfPage)) types.push(t);
  }
  meta.jsonLdTypes = [...new Set(types)];
  const work = mainWork ?? nodes.find((n) => n && (n.datePublished || n.headline)) ?? nodes[0];
  if (work && typeof work === 'object') {
    if (!meta.title && typeof work.headline === 'string') meta.title = work.headline;
    if (!meta.publishedAt && typeof work.datePublished === 'string')
      meta.publishedAt = work.datePublished;
    if (!meta.updatedAt && typeof work.dateModified === 'string')
      meta.updatedAt = work.dateModified;
    if (!meta.byline) meta.byline = personName(work.author) ?? personName(work.creator);
    if (!meta.lang && typeof work.inLanguage === 'string')
      meta.lang = normalizeLangTag(work.inLanguage);
    if (!meta.siteName && work.publisher && typeof work.publisher === 'object')
      meta.siteName = typeof work.publisher.name === 'string' ? work.publisher.name : undefined;
  }
  // Paywall flag: any node (or hasPart) declaring isAccessibleForFree=false wins.
  for (const n of nodes) {
    const flag = accessibleFlag(n);
    if (flag === false) meta.accessibleForFree = false;
    else if (flag === true && meta.accessibleForFree === undefined) meta.accessibleForFree = true;
    const parts = Array.isArray(n.hasPart) ? n.hasPart : n.hasPart ? [n.hasPart] : [];
    for (const p of parts) if (accessibleFlag(p) === false) meta.accessibleForFree = false;
  }
  if (mainWork && typeof mainWork.articleBody === 'string' && mainWork.articleBody.length > 0)
    meta.articleBody = mainWork.articleBody;

  // ── kind ─────────────────────────────────────────────────────────────────
  meta.kind = classifyKind(meta, q('meta[property="og:type"]')?.toLowerCase(), url);

  // URL date pattern (lowest confidence; only when nothing else declared a date).
  if (!meta.publishedAt) meta.publishedAt = dateFromUrl(url);

  return meta;
}

/** JSON-LD nodes flattened (@graph, arrays), tolerant of broken JSON. */
export function jsonLdNodes(document: any): any[] {
  const out: any[] = [];
  try {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const raw = (s.textContent ?? '').trim();
      if (!raw || raw.length > 2_000_000) continue;
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        // Some CMSs leave HTML comments or trailing commas; try a lenient trim.
        try {
          json = JSON.parse(raw.replace(/^<!--|-->$/g, '').replace(/,\s*([}\]])/g, '$1'));
        } catch {
          continue;
        }
      }
      const push = (n: any) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          for (const x of n) push(x);
          return;
        }
        out.push(n);
        if (Array.isArray(n['@graph'])) for (const x of n['@graph']) push(x);
      };
      push(json);
      if (out.length > 200) break;
    }
  } catch {
    /* ignore */
  }
  return out;
}

function typesOf(n: any): string[] {
  const t = n?.['@type'];
  const arr = Array.isArray(t) ? t : t ? [t] : [];
  return arr
    .filter((x) => typeof x === 'string')
    .map((x: string) => x.replace(/^.*[/#:]/, '').toLowerCase());
}

function personName(a: any): string | undefined {
  if (!a) return undefined;
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) {
    const names = a.map(personName).filter(Boolean) as string[];
    return names.length ? names.slice(0, 4).join(', ') : undefined;
  }
  if (typeof a === 'object' && typeof a.name === 'string') return a.name;
  return undefined;
}

function accessibleFlag(n: any): boolean | undefined {
  if (!n || typeof n !== 'object') return undefined;
  const v = n.isAccessibleForFree ?? n.isAccessibleforfree;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^(false|no|0)$/i.test(v.trim())) return false;
    if (/^(true|yes|1)$/i.test(v.trim())) return true;
  }
  return undefined;
}

function classifyKind(meta: PageMeta, ogType: string | undefined, url: string): PageKind {
  const t = new Set(meta.jsonLdTypes);
  const has = (...names: string[]) => names.some((n) => t.has(n));
  if (
    has('qapage', 'question', 'answer', 'discussionforumposting', 'comment', 'socialmediaposting')
  )
    return 'qa';
  if (has('techarticle', 'apireference')) return 'docs';
  if (
    has(
      'newsarticle',
      'analysisnewsarticle',
      'reportagenewsarticle',
      'reviewnewsarticle',
      'opinionnewsarticle',
      'backgroundnewsarticle',
      'liveblogposting',
    )
  )
    return 'news';
  if (has('blogposting')) return 'blog';
  if (has('product', 'productgroup', 'offer', 'individualproduct')) return 'product';
  if (has('videoobject', 'clip', 'movie', 'tvepisode')) return 'video';
  if (has('article', 'scholarlyarticle', 'report')) return 'article';
  if (ogType) {
    if (ogType.startsWith('video')) return 'video';
    if (ogType === 'product' || ogType.startsWith('product.')) return 'product';
    if (ogType === 'article') {
      if (/blog/i.test(meta.siteName ?? '') || /\/blog\//i.test(url)) return 'blog';
      return 'article';
    }
  }
  if (
    meta.generator &&
    /sphinx|docusaurus|mkdocs|mintlify|gitbook|vitepress|vuepress|docsify|hugo docs|antora|readthedocs|starlight/.test(
      meta.generator,
    )
  )
    return 'docs';
  if (/^\/(docs?|documentation|reference|api|manual|guides?)(\/|$)/i.test(safePath(url)))
    return 'docs';
  if (/^\/blog(\/|$)/i.test(safePath(url))) return 'blog';
  return 'other';
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function absolutize(href: string, base: string): string | undefined {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    u.hash = '';
    return u.href;
  } catch {
    return undefined;
  }
}

/**
 * Accept a canonical URL only when it is http(s) and does not point at the site root from a deep
 * page (some CMSs put the homepage in rel=canonical on every page, which would merge unrelated
 * pages). A self-canonical is returned as-is.
 */
export function sanitizeCanonical(candidate: string | undefined, url: string): string | undefined {
  if (!candidate) return undefined;
  const abs = absolutize(candidate, url);
  if (!abs) return undefined;
  let self: URL;
  let can: URL;
  try {
    self = new URL(url);
    can = new URL(abs);
  } catch {
    return undefined;
  }
  const selfPath = self.pathname.replace(/\/+$/, '');
  const canPath = can.pathname.replace(/\/+$/, '');
  if (canPath === '' && selfPath !== '') return undefined; // homepage canonical on a deep page
  return can.href;
}

/** `/2026/03/14/` or `/2026-03-14-slug` in the URL path → `YYYY-MM-DD` when plausible. */
export function dateFromUrl(url: string): string | undefined {
  const path = safePath(url);
  const m = /(?:^|\/)((?:19|20)\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])(?=[/-]|$)/.exec(
    path,
  );
  if (!m) return undefined;
  const y = Number(m[1]);
  if (y > new Date().getFullYear() + 1) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
