const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'yclid',
  'ref',
  'ref_src',
  'ref_url',
  '_ga',
  '_gl',
  'spm',
  'si',
  'feature',
  'ocid',
  'cmpid',
  'source',
]);

// ─── URL hygiene ─────────────────────────────────────────────────────────────

/** Redirect wrappers: host pattern → query parameter carrying the real target. */
const REDIRECTORS: { host: RegExp; path?: RegExp; params: string[] }[] = [
  { host: /^(www\.)?google\.[a-z.]+$/, path: /^\/url$/, params: ['q', 'url'] },
  { host: /^(l|lm)\.facebook\.com$/, path: /^\/l\.php$/, params: ['u'] },
  { host: /^l\.instagram\.com$/, params: ['u'] },
  { host: /^(www\.)?duckduckgo\.com$/, path: /^\/l\/?$/, params: ['uddg'] },
  { host: /^(www\.|m\.)?youtube\.com$/, path: /^\/redirect$/, params: ['q'] },
  { host: /^(www\.)?linkedin\.com$/, path: /^\/redir\/redirect$/, params: ['url'] },
  { host: /^slack-redir\.net$/, path: /^\/link$/, params: ['url'] },
];

const AMP_QUERY_PARAMS = new Set(['amp', 'amp_js_v', 'amp_gsa', 'usqp', 'outputtype', 'output']);
const WIKIMEDIA_MOBILE_RE =
  /^([a-z-]+)\.m\.(wikipedia|wiktionary|wikibooks|wikiquote|wikisource|wikinews|wikiversity|wikivoyage|wikimedia)\.org$/;

export interface CleanedUrl {
  /** The URL to fetch (redirect wrappers unwrapped, AMP/mobile variants folded, fragment removed). */
  url: string;
  /** Decoded `#:~:text=` fragment(s), joined with " … " when several were given. */
  textFragment?: string;
  /** True when the host/path/query changed (not merely the fragment). */
  rewritten: boolean;
}

/** Unwrap one level of a known redirect wrapper (google.com/url?q=, l.facebook.com/l.php?u= …). */
function unwrapRedirector(u: URL): URL | undefined {
  const host = u.hostname.toLowerCase();
  for (const r of REDIRECTORS) {
    if (!r.host.test(host)) continue;
    if (r.path && !r.path.test(u.pathname)) continue;
    for (const p of r.params) {
      const v = u.searchParams.get(p);
      if (!v) continue;
      try {
        const target = new URL(v);
        if (target.protocol === 'http:' || target.protocol === 'https:') return target;
      } catch {
        /* not a URL */
      }
    }
  }
  return undefined;
}

/** Fold AMP variants onto the canonical page (Google AMP cache, `amp.` hosts, `/amp` paths, `?amp`). */
function stripAmp(u: URL): void {
  const host = u.hostname.toLowerCase();
  // Google AMP cache: {pub}.cdn.ampproject.org/c/s/host/path  (or /v/s/, /wp/s/)
  const cache =
    /\.cdn\.ampproject\.org$/.test(host) && /^\/(c|v|wp)\/(s\/)?([^/]+)(\/.*)?$/.exec(u.pathname);
  if (cache) {
    const secure = !!cache[2];
    const target = new URL(`${secure ? 'https' : 'http'}://${cache[3]}${cache[4] ?? '/'}`);
    target.search = u.search;
    u.href = target.href;
  }
  const h = u.hostname.toLowerCase();
  if (h.startsWith('amp.') && h.split('.').length >= 3) u.hostname = h.slice(4);
  // Trailing /amp or /amp/ path segment; `.amp` before the extension (article.amp.html).
  u.pathname = u.pathname.replace(/\/amp\/?$/i, '').replace(/\.amp(\.html?)$/i, '$1');
  if (u.pathname === '') u.pathname = '/';
  for (const k of [...u.searchParams.keys()]) {
    const lk = k.toLowerCase();
    if (
      AMP_QUERY_PARAMS.has(lk) &&
      (lk !== 'outputtype' && lk !== 'output' ? true : /^amp$/i.test(u.searchParams.get(k) ?? ''))
    )
      u.searchParams.delete(k);
  }
  if (u.searchParams.size === 0) u.search = '';
}

/**
 * URL hygiene applied before fetching and before deduplication: unwrap search-engine/social
 * redirect wrappers, fold AMP and mobile-Wikipedia variants onto the canonical page, and pull the
 * text-fragment hint (`#:~:text=`) out of the hash before it is dropped.
 */
export function cleanUrl(input: string): CleanedUrl {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { url: input, rewritten: false };
  }
  const before = `${u.origin}${u.pathname}${u.search}`;
  for (let i = 0; i < 3; i++) {
    const next = unwrapRedirector(u);
    if (!next) break;
    u = next;
  }
  stripAmp(u);
  const m = WIKIMEDIA_MOBILE_RE.exec(u.hostname.toLowerCase());
  if (m) u.hostname = `${m[1]}.${m[2]}.org`;
  const textFragment = extractTextFragment(u.hash);
  u.hash = '';
  return {
    url: u.toString(),
    textFragment,
    rewritten: `${u.origin}${u.pathname}${u.search}` !== before,
  };
}

/** Decode `#:~:text=[prefix-,]start[,end][,-suffix]` directives (URL Fragment Text Directives). */
export function extractTextFragment(hash: string): string | undefined {
  const idx = hash.indexOf(':~:');
  if (idx < 0) return undefined;
  const parts: string[] = [];
  for (const directive of hash.slice(idx + 3).split('&')) {
    if (!directive.startsWith('text=')) continue;
    const spec = directive.slice(5);
    // Drop context terms (prefix-, -suffix); keep start[,end].
    const terms = spec
      .split(',')
      .filter((t) => !(t.startsWith('-') && t.length > 1) && !t.endsWith('-'))
      .map((t) => {
        try {
          return decodeURIComponent(t);
        } catch {
          return t;
        }
      })
      .filter(Boolean);
    if (terms.length) parts.push(terms.join(' … '));
  }
  const out = parts.join(' … ').replace(/\s+/g, ' ').trim();
  return out ? out.slice(0, 500) : undefined;
}

/**
 * Canonicalise a URL for deduplication: URL hygiene (redirect unwrapping, AMP/mobile folding),
 * lowercase host, strip fragment, drop tracking params, sort query, remove default ports and
 * trailing slash on non-root paths, drop `www.`.
 */
export function canonicalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(cleanUrl(input).url);
  } catch {
    return input;
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))
    u.port = '';
  const params = [...u.searchParams.entries()].filter(
    ([k]) => !TRACKING_PARAMS.has(k.toLowerCase()),
  );
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

/** Return the URL without fragment (keeps query), after URL hygiene — what we actually fetch. */
export function normalizeUrl(input: string): string | null {
  try {
    const u = new URL(cleanUrl(input).url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Registrable-ish domain used for per-host politeness queues. Not a full PSL implementation:
 * collapses `a.b.example.com` → `example.com`, keeps two-level ccTLDs like `bbc.co.uk`.
 */
export function registrableDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last = parts.at(-1) as string;
  const second = parts.at(-2) as string;
  const ccSecondLevel = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);
  if (last.length === 2 && ccSecondLevel.has(second) && parts.length >= 3)
    return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/** Match hostname against a domain pattern list (suffix match; `*.example.com` and `example.com` both match subdomains). */
export function matchesDomain(hostname: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const h = hostname.toLowerCase();
  return patterns.some((p) => {
    let d = p.trim().toLowerCase();
    if (!d) return false;
    if (d.startsWith('*.')) d = d.slice(2);
    if (d.startsWith('.')) d = d.slice(1);
    try {
      if (d.includes('/')) d = new URL(d.includes('://') ? d : `https://${d}`).hostname;
    } catch {
      /* keep */
    }
    return h === d || h.endsWith(`.${d}`);
  });
}

/** File extensions we know we cannot parse into text. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|svg|bmp|ico|mp4|mp3|wav|mov|avi|mkv|zip|gz|tar|7z|rar|exe|dmg|iso|apk|woff2?|ttf|otf|eot|css|js|mjs|map|wasm)(\?|$)/i;

export function looksBinary(url: string): boolean {
  try {
    return BINARY_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
