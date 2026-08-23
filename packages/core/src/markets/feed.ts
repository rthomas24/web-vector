/**
 * Tolerant RSS 2.0 / Atom / RSS 1.0 (RDF) parser on top of linkedom's XML DOM — no new
 * dependency. Returns plain items (title, link, date, summary, categories, publisher) with HTML
 * stripped from text fields. Feeds are untrusted input like any page: text goes through the
 * same `cleanSnippet` (tags, entities, control chars, caps) the search providers use.
 */
import { DOMParser } from 'linkedom';
import { cleanSnippet } from '../search/base.js';

export interface FeedItem {
  title: string;
  link?: string;
  /** ISO timestamp when the feed declared one. */
  publishedAt?: string;
  /** Plain text (tags stripped), capped. */
  summary?: string;
  categories: string[];
  /** Publisher named by an explicit `<source>` (RSS) / `<source><title>` (Atom); absent otherwise. */
  sourceName?: string;
}

export interface ParsedFeed {
  kind: 'rss' | 'atom' | 'rdf';
  title?: string;
  link?: string;
  items: FeedItem[];
}

const MAX_ITEMS = 200;
const MAX_SUMMARY = 600;
const MAX_TITLE = 300;
const FEED_RE = /<(rss|feed|rdf:RDF|channel)\b/i;

type El = Element;

/** Direct children whose tag (or local name after a namespace prefix) matches. */
function children(el: El, name: string): El[] {
  const want = name.toLowerCase();
  const out: El[] = [];
  for (const c of el.children as unknown as El[]) {
    const tag = (c.tagName || '').toLowerCase();
    if (tag === want || tag.endsWith(`:${want}`)) out.push(c);
  }
  return out;
}

function child(el: El, ...names: string[]): El | undefined {
  for (const n of names) {
    const c = children(el, n)[0];
    if (c) return c;
  }
  return undefined;
}

function text(el: El | undefined, max = MAX_SUMMARY): string | undefined {
  return el ? cleanSnippet(el.textContent, max) : undefined;
}

export function parseDate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!s) return undefined;
  let t = Date.parse(s);
  if (!Number.isFinite(t)) {
    // "Sat, 22 Aug 2026 20:35 GMT" variants without seconds or with odd zones
    t = Date.parse(s.replace(/\s+(UT|Z)$/i, ' GMT').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  }
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t);
  // Guard against absurd feed dates (year 1970/3000) that would break "since" filters.
  const y = d.getUTCFullYear();
  if (y < 1995 || y > 2100) return undefined;
  return d.toISOString();
}

function absolutize(href: string | null | undefined, base?: string): string | undefined {
  const h = href?.trim();
  if (!h) return undefined;
  try {
    return new URL(h, base).toString();
  } catch {
    return undefined;
  }
}

function atomLink(entry: El, base?: string): string | undefined {
  const links = children(entry, 'link');
  const pick =
    links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate') ?? links[0];
  return absolutize(pick?.getAttribute('href') ?? pick?.textContent, base);
}

function rssItem(it: El, base?: string): FeedItem | undefined {
  const title = text(child(it, 'title'), MAX_TITLE);
  let link = absolutize(child(it, 'link')?.textContent, base);
  if (!link) {
    const guidEl = child(it, 'guid');
    const guid = guidEl?.textContent?.trim();
    if (guid && guidEl?.getAttribute('isPermaLink') !== 'false' && /^https?:/i.test(guid))
      link = absolutize(guid, base);
  }
  if (!link) {
    // Atom-style <link href> inside RSS (some feeds).
    const a = children(it, 'link').find((l) => l.getAttribute('href'));
    link = absolutize(a?.getAttribute('href'), base);
  }
  if (!title && !link) return undefined;
  return {
    title: title ?? (link as string),
    link,
    publishedAt: parseDate(
      child(it, 'pubDate', 'date', 'published', 'updated')?.textContent ?? undefined,
    ),
    summary: text(child(it, 'description', 'encoded', 'summary')),
    categories: children(it, 'category')
      .map((c) => text(c, 80))
      .filter((c): c is string => !!c),
    sourceName: text(child(it, 'source'), 120),
  };
}

function atomEntry(e: El, base?: string): FeedItem | undefined {
  const title = text(child(e, 'title'), MAX_TITLE);
  const link = atomLink(e, base);
  if (!title && !link) return undefined;
  const source = child(e, 'source');
  return {
    title: title ?? (link as string),
    link,
    publishedAt: parseDate(child(e, 'published', 'updated')?.textContent ?? undefined),
    summary: text(child(e, 'summary', 'content')),
    categories: children(e, 'category')
      .map((c) =>
        cleanSnippet(c.getAttribute('term') ?? c.getAttribute('label') ?? c.textContent, 80),
      )
      .filter((c): c is string => !!c),
    sourceName: source ? text(child(source, 'title'), 120) : undefined,
  };
}

/**
 * Parse feed XML. Never throws on malformed feeds — returns what it could recover (possibly
 * zero items). `baseUrl` resolves relative links.
 */
export function parseFeed(xml: string, baseUrl?: string): ParsedFeed {
  const out: ParsedFeed = { kind: 'rss', items: [] };
  if (!xml || !FEED_RE.test(xml)) return out;
  let root: El | null;
  try {
    root = new DOMParser().parseFromString(xml, 'text/xml').documentElement as unknown as El | null;
  } catch {
    return out;
  }
  if (!root) return out;
  const rootTag = (root.tagName || '').toLowerCase();
  if (rootTag === 'feed') {
    out.kind = 'atom';
    out.title = text(child(root, 'title'), MAX_TITLE);
    out.link = atomLink(root, baseUrl);
    for (const e of children(root, 'entry')) {
      const item = atomEntry(e, out.link ?? baseUrl);
      if (item) out.items.push(item);
      if (out.items.length >= MAX_ITEMS) break;
    }
    return out;
  }
  // RSS 2.0: <rss><channel><item>…; RSS 1.0: <rdf:RDF><channel/><item/>…
  const channel = child(root, 'channel') ?? root;
  out.kind = rootTag.endsWith('rdf') ? 'rdf' : 'rss';
  out.title = text(child(channel, 'title'), MAX_TITLE);
  out.link = absolutize(child(channel, 'link')?.textContent, baseUrl);
  const items = [...children(channel, 'item'), ...(channel === root ? [] : children(root, 'item'))];
  for (const it of items) {
    const item = rssItem(it, out.link ?? baseUrl);
    if (item) out.items.push(item);
    if (out.items.length >= MAX_ITEMS) break;
  }
  return out;
}
