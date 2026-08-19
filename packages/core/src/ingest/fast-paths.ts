/**
 * URL-rewrite and API-backed fast paths: for a handful of high-value hosts the HTML page is the
 * worst way to get the content (arXiv abs = abstract only, GitHub repo page = 400 KB of React
 * JSON, Stack Overflow = robots-disallowed HTML, HN = 30 s crawl-delay), while a robots-allowed,
 * keyless alternative gives the full text.
 *
 * Every rewrite still goes through the normal Fetcher (SSRF guard, robots.txt of the rewritten
 * host, politeness queue, size caps) with `retries: 0`; on any failure the caller falls back to
 * fetching the original URL. `doc.url` stays the original URL for citations; `finalUrl` is the
 * rewritten one. API-rendered documents are markdown built from JSON — untrusted text like any
 * page. Enable/disable with `ingestion.fastPaths: true | false | string[]` (ids below).
 *
 * Verified 2026-08-18: arxiv.org robots allows /abs /pdf /html (Crawl-delay 15); raw.githubusercontent.com,
 * api.github.com, hn.algolia.com, hacker-news.firebaseio.com (`Allow: /*.json$`), api.stackexchange.com
 * and registry.npmjs.org have no restricting robots.txt; docs.google.com allows /document.
 * pypi.org now lists `Disallow: /pypi/*\/json`, so that rewrite is normally refused by the robots
 * check and falls back to the project page (kept in case the policy changes).
 */
import { htmlToMarkdown } from 'mdream';
import { WebVectorError } from '../errors.js';
import type { Logger } from '../types.js';
import type { FetchedResource, FetchInit } from './fetcher.js';
import { cleanField, sanitizeText } from './parsers.js';

export interface FastPathContext {
  /** The (cleaned) URL being ingested. */
  url: URL;
  /** Guarded fetch through the Fetcher (robots/SSRF/politeness); throws WebVectorError. */
  fetch: (url: string, init?: FetchInit) => Promise<FetchedResource>;
  signal?: AbortSignal;
  /** Environment for optional API keys (`STACKEXCHANGE_KEY`, `GITHUB_TOKEN`). */
  env: NodeJS.ProcessEnv;
  logger?: Logger;
}

export interface FastPath {
  /** Stable id used in `ingestion.fastPaths: string[]` and `doc.metadata.fastPath`. */
  id: string;
  /** Short description for docs/status. */
  description: string;
  match(url: URL): boolean;
  /**
   * Produce a resource for the URL or return null to fall back to the normal fetch. Throwing is
   * treated like null (logged at debug level).
   */
  resolve(ctx: FastPathContext): Promise<FetchedResource | null>;
}

// ─── registry + rate-limit awareness ────────────────────────────────────────

const registry: FastPath[] = [];
const cooldownUntil = new Map<string, number>();

/** Register a custom fast path (matched after the built-ins). */
export function registerFastPath(fp: FastPath): void {
  const i = registry.findIndex((f) => f.id === fp.id);
  if (i >= 0) registry.splice(i, 1, fp);
  else registry.push(fp);
}

export function listFastPaths(): readonly FastPath[] {
  return registry;
}

/** Disable a fast path for a while (API quota exhausted, 429…). */
export function cooldownFastPath(id: string, ms: number): void {
  cooldownUntil.set(id, Date.now() + Math.max(0, ms));
}

/** The enabled fast path for a URL, if any (respecting cooldowns). */
export function selectFastPath(
  url: string | URL,
  enabled: boolean | string[] = true,
): FastPath | undefined {
  if (enabled === false) return undefined;
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return undefined;
  }
  const allow = Array.isArray(enabled) ? new Set(enabled) : undefined;
  return registry.find(
    (fp) =>
      (!allow || allow.has(fp.id)) && (cooldownUntil.get(fp.id) ?? 0) <= Date.now() && fp.match(u),
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

/** Build a text/markdown resource for the original URL from API-rendered markdown. */
function markdownResource(
  ctx: FastPathContext,
  id: string,
  api: FetchedResource,
  markdown: string,
): FetchedResource {
  return {
    url: ctx.url.toString(),
    finalUrl: api.finalUrl,
    status: api.status,
    contentType: 'text/markdown',
    charset: 'utf-8',
    bytes: enc.encode(markdown),
    ms: api.ms,
    redirects: api.redirects,
    headers: new Headers({ 'content-type': 'text/markdown; charset=utf-8' }),
    contentSignal: api.contentSignal,
    fastPath: { id, api: true },
  };
}

/** Rewrite result: same bytes, original `url` for citations, tagged with the fast path. */
function rewritten(ctx: FastPathContext, id: string, res: FetchedResource): FetchedResource {
  return { ...res, url: ctx.url.toString(), fastPath: { id, api: false } };
}

/** Try candidate URLs in order; 404/410 moves on, other errors abort (→ fallback). */
async function firstOk(
  ctx: FastPathContext,
  candidates: string[],
  init?: FetchInit,
): Promise<FetchedResource | null> {
  for (const c of candidates) {
    try {
      return await ctx.fetch(c, { retries: 0, ...init });
    } catch (err) {
      const status = WebVectorError.is(err) ? (err.details as { status?: number })?.status : 0;
      if (status === 404 || status === 410) continue;
      throw err;
    }
  }
  return null;
}

function decodeJson<T>(res: FetchedResource): T {
  return JSON.parse(new TextDecoder(res.charset || 'utf-8').decode(res.bytes)) as T;
}

/** Convert an HTML fragment (API bodies) to markdown; falls back to tag stripping. */
export function htmlFragmentToMarkdown(html: string, origin?: string): string {
  if (!html) return '';
  try {
    return tidy(htmlToMarkdown(html, origin ? { origin } : undefined));
  } catch {
    return tidy(html.replace(/<[^>]+>/g, ' '));
  }
}

function tidy(md: string): string {
  return sanitizeText(md)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fm(pairs: Record<string, string | number | undefined>): string {
  const lines = Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${JSON.stringify(String(v).slice(0, 300))}`);
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

function isoDate(v: string | number | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/** Cap a rendered document (chars) so a 5 000-comment thread does not become a 5 MB page. */
const MAX_RENDER_CHARS = 400_000;

// ─── C5: URL-rewrite fast paths ──────────────────────────────────────────────

const ARXIV_ID_RE = /^\/abs\/((?:[a-z-]+(?:\.[A-Z]{2})?\/)?\d{4,}(?:\.\d{4,5})?(?:v\d+)?)\/?$/i;

const arxiv: FastPath = {
  id: 'arxiv',
  description: 'arxiv.org/abs/{id} → arxiv.org/html/{id} (full paper), else /pdf/{id}',
  match: (u) => /^(www\.|export\.)?arxiv\.org$/.test(u.hostname) && ARXIV_ID_RE.test(u.pathname),
  async resolve(ctx) {
    const id = ARXIV_ID_RE.exec(ctx.url.pathname)?.[1] as string;
    const res = await firstOk(ctx, [`https://arxiv.org/html/${id}`, `https://arxiv.org/pdf/${id}`]);
    return res ? rewritten(ctx, 'arxiv', res) : null;
  },
};

const GITHUB_RESERVED = new Set([
  'about',
  'apps',
  'blog',
  'codespaces',
  'collections',
  'contact',
  'customer-stories',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'readme',
  'search',
  'security',
  'settings',
  'site',
  'sponsors',
  'team',
  'topics',
  'trending',
]);

function githubRepo(u: URL): { owner: string; repo: string; rest: string[] } | undefined {
  if (!/^(www\.)?github\.com$/.test(u.hostname)) return undefined;
  const parts = u.pathname.split('/').filter(Boolean);
  const [owner, repo, ...rest] = parts;
  if (!owner || !repo || GITHUB_RESERVED.has(owner.toLowerCase())) return undefined;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
  return { owner, repo: repo.replace(/\.git$/, ''), rest };
}

const githubReadme: FastPath = {
  id: 'github-readme',
  description: 'github.com/o/r → raw.githubusercontent.com/o/r/HEAD/README.md',
  match: (u) => {
    const r = githubRepo(u);
    return !!r && r.rest.length === 0;
  },
  async resolve(ctx) {
    const r = githubRepo(ctx.url) as NonNullable<ReturnType<typeof githubRepo>>;
    const base = `https://raw.githubusercontent.com/${r.owner}/${r.repo}/HEAD/`;
    const res = await firstOk(ctx, [
      `${base}README.md`,
      `${base}readme.md`,
      `${base}README.rst`,
      `${base}README`,
    ]);
    if (!res) return null;
    const out = rewritten(ctx, 'github-readme', res);
    // raw.githubusercontent serves text/plain; the .md path routes it to the served-markdown cleaner.
    return out;
  },
};

const githubBlob: FastPath = {
  id: 'github-blob',
  description: 'github.com/o/r/blob/ref/path → raw.githubusercontent.com/o/r/ref/path',
  match: (u) => {
    const r = githubRepo(u);
    return !!r && r.rest[0] === 'blob' && r.rest.length >= 3;
  },
  async resolve(ctx) {
    const r = githubRepo(ctx.url) as NonNullable<ReturnType<typeof githubRepo>>;
    const path = r.rest.slice(1).join('/');
    const res = await firstOk(ctx, [
      `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${path}`,
    ]);
    return res ? rewritten(ctx, 'github-blob', res) : null;
  },
};

const googleDocs: FastPath = {
  id: 'google-docs',
  description: 'docs.google.com/document/d/{id} → …/export?format=md',
  match: (u) =>
    u.hostname === 'docs.google.com' && /^\/document\/(?:u\/\d+\/)?d\/[\w-]+/.test(u.pathname),
  async resolve(ctx) {
    const id = /\/document\/(?:u\/\d+\/)?d\/([\w-]+)/.exec(ctx.url.pathname)?.[1];
    if (!id) return null;
    const res = await firstOk(ctx, [`https://docs.google.com/document/d/${id}/export?format=md`]);
    if (!res) return null;
    // Export bodies may come back unlabelled; they are markdown.
    return {
      ...rewritten(ctx, 'google-docs', res),
      contentType: 'text/markdown',
      charset: res.charset ?? 'utf-8',
    };
  },
};

interface NpmPackument {
  name?: string;
  description?: string;
  readme?: string;
  homepage?: string;
  license?: string;
  'dist-tags'?: { latest?: string };
  time?: { modified?: string };
  repository?: { url?: string } | string;
}

const npm: FastPath = {
  id: 'npm',
  description: 'npmjs.com/package/x → registry.npmjs.org/x (readme)',
  match: (u) =>
    /^(www\.)?npmjs\.(com|org)$/.test(u.hostname) &&
    /^\/package\/(@[\w.-]+\/)?[\w.-]+\/?$/.test(u.pathname),
  async resolve(ctx) {
    const name = ctx.url.pathname.replace(/^\/package\//, '').replace(/\/$/, '');
    const res = await firstOk(ctx, [`https://registry.npmjs.org/${name}`]);
    if (!res) return null;
    const pkg = decodeJson<NpmPackument>(res);
    const readme = typeof pkg.readme === 'string' ? pkg.readme : '';
    if (readme.trim().length < 40) return null;
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const md =
      fm({
        title: pkg.name ?? name,
        description: pkg.description,
        version: pkg['dist-tags']?.latest,
        license: pkg.license,
        date: pkg.time?.modified,
      }) +
      `# ${pkg.name ?? name}\n\n` +
      (pkg.description ? `${pkg.description}\n\n` : '') +
      `Package: https://www.npmjs.com/package/${name}` +
      (pkg['dist-tags']?.latest ? ` · latest ${pkg['dist-tags'].latest}` : '') +
      (pkg.license ? ` · ${pkg.license}` : '') +
      (pkg.homepage ? ` · [homepage](${pkg.homepage})` : '') +
      (repo ? ` · repository ${repo.replace(/^git\+/, '').replace(/\.git$/, '')}` : '') +
      `\n\n${readme.slice(0, MAX_RENDER_CHARS)}`;
    return markdownResource(ctx, 'npm', res, md);
  },
};

interface PypiJson {
  info?: {
    name?: string;
    summary?: string;
    description?: string;
    description_content_type?: string;
    version?: string;
    license?: string;
    home_page?: string;
    project_url?: string;
  };
}

const pypi: FastPath = {
  id: 'pypi',
  description:
    'pypi.org/project/x → pypi.org/pypi/x/json (description) — currently robots-disallowed',
  match: (u) =>
    /^(www\.)?pypi\.org$/.test(u.hostname) && /^\/project\/[\w.-]+\/?$/.test(u.pathname),
  async resolve(ctx) {
    const name = ctx.url.pathname.split('/')[2] as string;
    const res = await firstOk(ctx, [`https://pypi.org/pypi/${name}/json`]);
    if (!res) return null;
    const info = decodeJson<PypiJson>(res).info ?? {};
    const desc = info.description ?? '';
    if (desc.trim().length < 40) return null;
    const body = /html/i.test(info.description_content_type ?? '')
      ? htmlFragmentToMarkdown(desc)
      : desc;
    const md =
      fm({
        title: info.name ?? name,
        description: info.summary,
        version: info.version,
        license: info.license,
      }) +
      `# ${info.name ?? name}\n\n` +
      (info.summary ? `${info.summary}\n\n` : '') +
      `Package: https://pypi.org/project/${name}/` +
      (info.version ? ` · ${info.version}` : '') +
      (info.home_page || info.project_url
        ? ` · [homepage](${info.home_page || info.project_url})`
        : '') +
      `\n\n${body.slice(0, MAX_RENDER_CHARS)}`;
    return markdownResource(ctx, 'pypi', res, md);
  },
};

// ─── C14: API-backed forum fast paths ────────────────────────────────────────

interface HnItem {
  id: number;
  author?: string | null;
  title?: string | null;
  url?: string | null;
  text?: string | null;
  points?: number | null;
  type?: string;
  created_at?: string;
  children?: HnItem[];
}
interface HnFirebaseItem {
  id: number;
  by?: string;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  time?: number;
  type?: string;
  kids?: number[];
}

/** Render an Algolia HN item tree as threaded markdown (comments nested as blockquotes, depth ≤ 4). */
export function renderHnThread(item: HnItem, sourceUrl: string): string {
  const title = cleanField(item.title ?? '') ?? `Hacker News item ${item.id}`;
  let out =
    fm({ title, date: item.created_at, author: item.author ?? undefined }) +
    `# ${title}\n\n` +
    (item.url ? `Link: ${item.url}\n\n` : '') +
    `${item.points ?? 0} points by ${item.author ?? '[deleted]'}` +
    (item.created_at ? ` on ${item.created_at.slice(0, 10)}` : '') +
    ` · ${sourceUrl}\n\n`;
  if (item.text) out += `${htmlFragmentToMarkdown(item.text)}\n\n`;
  const comments: string[] = [];
  let count = 0;
  const walk = (nodes: HnItem[] | undefined, depth: number) => {
    for (const c of nodes ?? []) {
      if (count >= 400 || out.length + comments.join('').length > MAX_RENDER_CHARS) return;
      const body = htmlFragmentToMarkdown(c.text ?? '');
      if (body) {
        count++;
        const quote = '> '.repeat(Math.min(depth, 4));
        const head = `**${c.author ?? '[deleted]'}**${c.created_at ? ` · ${c.created_at.slice(0, 10)}` : ''}`;
        const lines = [head, '', ...body.split('\n')].map((l) => (quote + l).trimEnd());
        comments.push(`${lines.join('\n')}\n\n`);
      }
      walk(c.children, depth + 1);
    }
  };
  walk(item.children, 0);
  if (comments.length) out += `## Comments (${count})\n\n${comments.join('')}`;
  return tidy(out);
}

const hackerNews: FastPath = {
  id: 'hackernews',
  description: 'news.ycombinator.com/item?id=N → hn.algolia.com/api/v1/items/N (Firebase fallback)',
  match: (u) =>
    /^(www\.)?news\.ycombinator\.com$/.test(u.hostname) &&
    u.pathname === '/item' &&
    /^\d+$/.test(u.searchParams.get('id') ?? ''),
  async resolve(ctx) {
    const id = ctx.url.searchParams.get('id') as string;
    const source = `https://news.ycombinator.com/item?id=${id}`;
    try {
      const res = await ctx.fetch(`https://hn.algolia.com/api/v1/items/${id}`, { retries: 0 });
      const item = decodeJson<HnItem>(res);
      if (item && typeof item.id === 'number')
        return markdownResource(ctx, 'hackernews', res, renderHnThread(item, source));
    } catch (err) {
      if (WebVectorError.is(err, 'PROVIDER_RATE_LIMITED'))
        cooldownFastPath('hackernews', err.retryAfterMs ?? 60_000);
      ctx.logger?.debug(
        `fast-path hackernews: algolia failed (${(err as Error).message}); trying firebase`,
      );
    }
    // Firebase (official API, robots `Allow: /*.json$`): story + first-level comments only.
    const res = await firstOk(ctx, [`https://hacker-news.firebaseio.com/v0/item/${id}.json`]);
    if (!res) return null;
    const fb = decodeJson<HnFirebaseItem | null>(res);
    if (!fb || typeof fb.id !== 'number') return null;
    const kids = (fb.kids ?? []).slice(0, 30);
    const children: HnItem[] = [];
    for (const kid of kids) {
      try {
        const kr = await ctx.fetch(`https://hacker-news.firebaseio.com/v0/item/${kid}.json`, {
          retries: 0,
        });
        const k = decodeJson<HnFirebaseItem | null>(kr);
        if (k?.text)
          children.push({
            id: k.id,
            author: k.by,
            text: k.text,
            created_at: isoDate(k.time),
          });
      } catch {
        break;
      }
    }
    const item: HnItem = {
      id: fb.id,
      author: fb.by,
      title: fb.title,
      url: fb.url,
      text: fb.text,
      points: fb.score,
      created_at: isoDate(fb.time),
      children,
    };
    return markdownResource(ctx, 'hackernews', res, renderHnThread(item, source));
  },
};

interface SeOwner {
  display_name?: string;
  link?: string;
}
interface SeQuestion {
  question_id: number;
  title?: string;
  body?: string;
  score?: number;
  is_answered?: boolean;
  accepted_answer_id?: number;
  answer_count?: number;
  creation_date?: number;
  last_activity_date?: number;
  tags?: string[];
  link?: string;
  owner?: SeOwner;
  content_license?: string;
}
interface SeAnswer {
  answer_id: number;
  body?: string;
  score?: number;
  is_accepted?: boolean;
  creation_date?: number;
  owner?: SeOwner;
  content_license?: string;
}
interface SeWrapper<T> {
  items?: T[];
  backoff?: number;
  quota_remaining?: number;
  error_id?: number;
  error_name?: string;
}

/** Map a Stack Exchange host to the API `site` parameter (stackoverflow, superuser, meta.stackoverflow, softwareengineering…). */
export function stackExchangeSite(hostname: string): string | undefined {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  const direct: Record<string, string> = {
    'stackoverflow.com': 'stackoverflow',
    'superuser.com': 'superuser',
    'serverfault.com': 'serverfault',
    'askubuntu.com': 'askubuntu',
    'mathoverflow.net': 'mathoverflow',
    'stackapps.com': 'stackapps',
  };
  if (direct[h]) return direct[h];
  const meta = /^meta\.(stackoverflow\.com|superuser\.com|serverfault\.com|askubuntu\.com)$/.exec(
    h,
  );
  if (meta) return `meta.${direct[meta[1] as string]}`;
  const se = /^(?:([a-z0-9-]+)\.)?(?:meta\.)?([a-z0-9-]+)\.stackexchange\.com$/.exec(h);
  if (se) {
    // {site}.stackexchange.com | meta.{site}.stackexchange.com | {lang}.stackoverflow.com is handled above
    if (h.startsWith('meta.')) return `meta.${se[2]}`;
    return se[1] ? `${se[1]}.${se[2]}` : se[2];
  }
  const lang = /^([a-z]{2})\.stackoverflow\.com$/.exec(h);
  if (lang) return `${lang[1]}.stackoverflow`;
  return undefined;
}

/** Render question + answers as `## Question / ### Answer (score N, accepted)` with CC BY-SA attribution. */
export function renderStackExchange(q: SeQuestion, answers: SeAnswer[], sourceUrl: string): string {
  const title = cleanField(q.title ?? '') ?? `Question ${q.question_id}`;
  const license = q.content_license ?? 'CC BY-SA 4.0';
  const who = (o?: SeOwner) => (o?.display_name ? cleanField(o.display_name, 80) : 'anonymous');
  let out =
    fm({ title, date: isoDate(q.creation_date), tags: (q.tags ?? []).join(', ') }) +
    `# ${title}\n\n` +
    `## Question (score ${q.score ?? 0}) — asked by ${who(q.owner)}` +
    (q.creation_date ? ` on ${(isoDate(q.creation_date) as string).slice(0, 10)}` : '') +
    (q.tags?.length ? ` · tags: ${q.tags.join(', ')}` : '') +
    `\n\n${htmlFragmentToMarkdown(q.body ?? '')}\n\n`;
  const sorted = [...answers].sort(
    (a, b) => Number(!!b.is_accepted) - Number(!!a.is_accepted) || (b.score ?? 0) - (a.score ?? 0),
  );
  for (const a of sorted) {
    if (out.length > MAX_RENDER_CHARS) break;
    out +=
      `### Answer (score ${a.score ?? 0}${a.is_accepted ? ', accepted' : ''}) — by ${who(a.owner)}` +
      (a.creation_date ? ` on ${(isoDate(a.creation_date) as string).slice(0, 10)}` : '') +
      `\n\n${htmlFragmentToMarkdown(a.body ?? '')}\n\n`;
  }
  out += `---\n\nSource: ${q.link ?? sourceUrl} · Question and answers © their authors, licensed under ${license} (https://stackoverflow.com/help/licensing).\n`;
  return tidy(out);
}

const stackExchange: FastPath = {
  id: 'stackexchange',
  description:
    'stackoverflow.com | *.stackexchange.com /questions/{id} → api.stackexchange.com/2.3 (question + answers, withbody)',
  match: (u) => !!stackExchangeSite(u.hostname) && /^\/(?:questions|q)\/\d+/.test(u.pathname),
  async resolve(ctx) {
    const site = stackExchangeSite(ctx.url.hostname) as string;
    const id = /^\/(?:questions|q)\/(\d+)/.exec(ctx.url.pathname)?.[1] as string;
    const key = ctx.env.STACKEXCHANGE_KEY
      ? `&key=${encodeURIComponent(ctx.env.STACKEXCHANGE_KEY)}`
      : '';
    const base = 'https://api.stackexchange.com/2.3';
    const q = `${base}/questions/${id}?site=${site}&filter=withbody${key}`;
    const a = `${base}/questions/${id}/answers?site=${site}&filter=withbody&order=desc&sort=votes&pagesize=30${key}`;
    let qres: FetchedResource;
    try {
      qres = await ctx.fetch(q, { retries: 0 });
    } catch (err) {
      if (WebVectorError.is(err, 'PROVIDER_RATE_LIMITED'))
        cooldownFastPath('stackexchange', err.retryAfterMs ?? 5 * 60_000);
      const status = WebVectorError.is(err) ? (err.details as { status?: number })?.status : 0;
      if (status === 400) cooldownFastPath('stackexchange', 5 * 60_000); // throttle_violation
      throw err;
    }
    const qw = decodeJson<SeWrapper<SeQuestion>>(qres);
    if (qw.backoff) cooldownFastPath('stackexchange', qw.backoff * 1000);
    if (qw.quota_remaining === 0) cooldownFastPath('stackexchange', 60 * 60_000);
    const question = qw.items?.[0];
    if (!question) return null;
    let answers: SeAnswer[] = [];
    if ((question.answer_count ?? 0) > 0 && !qw.backoff) {
      try {
        const ares = await ctx.fetch(a, { retries: 0 });
        const aw = decodeJson<SeWrapper<SeAnswer>>(ares);
        if (aw.backoff) cooldownFastPath('stackexchange', aw.backoff * 1000);
        answers = aw.items ?? [];
      } catch (err) {
        ctx.logger?.debug(`fast-path stackexchange: answers failed (${(err as Error).message})`);
      }
    }
    return markdownResource(
      ctx,
      'stackexchange',
      qres,
      renderStackExchange(question, answers, ctx.url.toString()),
    );
  },
};

interface GhUser {
  login?: string;
}
interface GhIssue {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  user?: GhUser;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  comments?: number;
  labels?: { name?: string }[];
  pull_request?: unknown;
  merged_at?: string | null;
}
interface GhComment {
  body?: string;
  user?: GhUser;
  created_at?: string;
}

/** Render a GitHub issue/PR + comments as markdown (bodies are already markdown; untrusted). */
export function renderGithubIssue(
  repo: string,
  issue: GhIssue,
  comments: GhComment[],
  sourceUrl: string,
): string {
  const kind = issue.pull_request ? 'Pull request' : 'Issue';
  const title = cleanField(issue.title ?? '') ?? `${kind} #${issue.number}`;
  const labels = (issue.labels ?? []).map((l) => l.name).filter(Boolean) as string[];
  let out =
    fm({
      title: `${title} · ${repo}#${issue.number}`,
      date: issue.created_at,
      updated: issue.updated_at,
    }) +
    `# ${title}\n\n` +
    `${kind} ${repo}#${issue.number} · ${issue.state ?? 'open'}` +
    (issue.merged_at ? ' (merged)' : '') +
    ` · opened by ${issue.user?.login ?? 'ghost'}` +
    (issue.created_at ? ` on ${issue.created_at.slice(0, 10)}` : '') +
    (labels.length ? ` · labels: ${labels.join(', ')}` : '') +
    ` · ${issue.html_url ?? sourceUrl}\n\n` +
    `${tidy(issue.body ?? '_(no description)_')}\n\n`;
  if (comments.length) {
    out += `## Comments (${comments.length})\n\n`;
    for (const c of comments) {
      if (out.length > MAX_RENDER_CHARS) break;
      out += `### ${c.user?.login ?? 'ghost'}${c.created_at ? ` · ${c.created_at.slice(0, 10)}` : ''}\n\n${tidy(c.body ?? '')}\n\n`;
    }
  }
  return tidy(out);
}

const githubIssue: FastPath = {
  id: 'github-issue',
  description: 'github.com/o/r/issues|pull/{n} → api.github.com REST (issue + comments)',
  match: (u) => {
    const r = githubRepo(u);
    return !!r && (r.rest[0] === 'issues' || r.rest[0] === 'pull') && /^\d+$/.test(r.rest[1] ?? '');
  },
  async resolve(ctx) {
    const r = githubRepo(ctx.url) as NonNullable<ReturnType<typeof githubRepo>>;
    const n = r.rest[1] as string;
    const repo = `${r.owner}/${r.repo}`;
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
    if (ctx.env.GITHUB_TOKEN) headers.authorization = `Bearer ${ctx.env.GITHUB_TOKEN}`;
    const base = `https://api.github.com/repos/${repo}/issues/${n}`;
    const noteLimit = (res: FetchedResource) => {
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        cooldownFastPath(
          'github-issue',
          Number.isFinite(reset) ? Math.max(0, reset - Date.now()) : 60 * 60_000,
        );
      }
    };
    let ires: FetchedResource;
    try {
      ires = await ctx.fetch(base, { retries: 0, headers });
    } catch (err) {
      const status = WebVectorError.is(err) ? (err.details as { status?: number })?.status : 0;
      if (status === 403 || status === 429) cooldownFastPath('github-issue', 60 * 60_000); // unauth quota (60/h)
      throw err;
    }
    noteLimit(ires);
    const issue = decodeJson<GhIssue>(ires);
    if (typeof issue?.number !== 'number') return null;
    let comments: GhComment[] = [];
    if ((issue.comments ?? 0) > 0) {
      try {
        const cres = await ctx.fetch(`${base}/comments?per_page=100`, { retries: 0, headers });
        noteLimit(cres);
        comments = decodeJson<GhComment[]>(cres);
      } catch (err) {
        ctx.logger?.debug(`fast-path github-issue: comments failed (${(err as Error).message})`);
      }
    }
    return markdownResource(
      ctx,
      'github-issue',
      ires,
      renderGithubIssue(repo, issue, Array.isArray(comments) ? comments : [], ctx.url.toString()),
    );
  },
};

export const builtinFastPaths: readonly FastPath[] = [
  arxiv,
  githubIssue,
  githubBlob,
  githubReadme,
  googleDocs,
  npm,
  pypi,
  hackerNews,
  stackExchange,
];
for (const fp of builtinFastPaths) registerFastPath(fp);
