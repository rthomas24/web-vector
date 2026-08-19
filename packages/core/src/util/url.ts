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

/**
 * Canonicalise a URL for deduplication: lowercase host, strip fragment, drop tracking params,
 * sort query, remove default ports and trailing slash on non-root paths, drop `www.`.
 */
export function canonicalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
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

/** Return the URL without fragment (keeps query) — what we actually fetch. */
export function normalizeUrl(input: string): string | null {
  try {
    const u = new URL(input);
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
