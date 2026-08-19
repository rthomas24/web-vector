/**
 * "Errors that teach": every failure or empty result tells the model what to try next, in-band.
 * Zero passages is NOT an error. Structured results carry `hint` and `retryable`.
 */
import { hostnameOf, PROVIDER_KEY_ENV, WebVectorError } from 'webvector';

export const NO_PASSAGES_HINT =
  '_No relevant passages. Try: drop freshness, remove domain filters, 2–3 related_queries with synonyms, or webvector_search to inspect the SERP._';

const KEYED_SEARCH = ['brave', 'serper', 'tavily', 'exa', 'serpapi'];

/** Human hint for a thrown WebVectorError, by code. */
export function hintFor(e: WebVectorError): { hint: string; retryable: boolean } {
  switch (e.code) {
    case 'PROVIDER_RATE_LIMITED': {
      const wait = e.retryAfterMs
        ? `Retry in ${Math.ceil(e.retryAfterMs / 1000)}s`
        : 'Retry shortly';
      const alts = KEYED_SEARCH.map((p) => `${p} (${(PROVIDER_KEY_ENV[p] ?? [])[0]})`).join(', ');
      return {
        hint: `${wait}, use depth: "fast" / fewer related_queries, or switch to a keyed search provider: WEBVECTOR_SEARCH_PROVIDER=… with ${alts}.`,
        retryable: true,
      };
    }
    case 'SEARCH_BLOCKED':
      return {
        hint: `The search provider blocked the request (bot check). Retry later, or configure a keyed provider (${KEYED_SEARCH.join(' | ')}) via WEBVECTOR_SEARCH_PROVIDER + its API key.`,
        retryable: true,
      };
    case 'SEARCH_FAILED':
    case 'PROVIDER_ERROR':
      return {
        hint: 'Retry once; if it persists, run webvector_status to check the configured providers.',
        retryable: true,
      };
    case 'MISSING_API_KEY':
    case 'PROVIDER_AUTH':
    case 'INVALID_CONFIG':
    case 'MISSING_DEPENDENCY':
    case 'UNKNOWN_PROVIDER':
      return {
        hint: 'Server configuration problem — not fixable from the tool call; report it to the operator (webvector_status shows the resolved config).',
        retryable: false,
      };
    case 'FETCH_BLOCKED_SSRF':
      return {
        hint: 'Only public http(s) URLs can be fetched (no localhost/private networks/metadata endpoints).',
        retryable: false,
      };
    case 'FETCH_BLOCKED_ROBOTS':
      return {
        hint: 'The site disallows automated fetching of this URL (robots.txt). Use webvector_search snippets or another source.',
        retryable: false,
      };
    case 'FETCH_HTTP_ERROR':
    case 'FETCH_TIMEOUT':
    case 'FETCH_FAILED':
    case 'TOO_MANY_REDIRECTS':
      return {
        hint: 'The page could not be fetched. Check the URL, try the canonical/https form, or use webvector_research to find an alternative source.',
        retryable: e.code !== 'TOO_MANY_REDIRECTS',
      };
    case 'FETCH_TOO_LARGE':
      return {
        hint: 'The resource exceeds the size cap. Pass a query to webvector_fetch to get only relevant passages, or fetch a more specific page.',
        retryable: false,
      };
    case 'UNSUPPORTED_CONTENT_TYPE':
      return {
        hint: 'Only HTML, PDF and text are readable. Look for an HTML/PDF version of the resource.',
        retryable: false,
      };
    case 'PARSE_EMPTY':
    case 'PARSE_FAILED':
      return {
        hint: 'No readable main content (JS-rendered app, login wall or empty page). Try webvector_fetch with a CSS selector, or another source.',
        retryable: false,
      };
    case 'ABORTED':
      return {
        hint: 'The call was cancelled or exceeded the client timeout; retry with depth: "fast" or a smaller max_pages.',
        retryable: true,
      };
    default:
      return {
        hint: e.retryable ? 'Retry once.' : 'Rephrase the request or try another tool.',
        retryable: e.retryable,
      };
  }
}

/** Standard error result: text + structured error/hint/retryable. */
export function errorResult(err: unknown) {
  const e = WebVectorError.from(err, { code: 'INTERNAL' });
  const { hint, retryable } = hintFor(e);
  return {
    content: [{ type: 'text' as const, text: `Error (${e.code}): ${e.describe()}\n→ ${hint}` }],
    isError: true,
    structuredContent: {
      error: e.toJSON(),
      hint,
      retryable,
      ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}),
    },
  };
}

/** In-band, teachable rejection for bad arguments (before any network work). */
export function argumentError(code: string, message: string, hint: string) {
  return {
    content: [{ type: 'text' as const, text: `Error (${code}): ${message}\n→ ${hint}` }],
    isError: true,
    structuredContent: { error: { code, message }, hint, retryable: true },
  };
}

/**
 * Validate domain filters: entries must be bare domains ("docs.python.org"). Returns the corrected
 * list, or an error message + suggestion when an entry cannot be interpreted.
 */
export function validateDomains(
  name: string,
  values: string[] | undefined,
): { ok: true; domains?: string[] } | { ok: false; message: string; hint: string } {
  if (!values?.length) return { ok: true, domains: values };
  const bad: string[] = [];
  const fixed = values.map((v) => {
    const t = v.trim().toLowerCase().replace(/^\*\./, '');
    if (/^[a-z0-9.-]+$/.test(t) && t.includes('.')) return t;
    try {
      const host = hostnameOf(t.includes('://') ? t : `https://${t}`);
      if (host?.includes('.')) return host;
    } catch {
      /* fallthrough */
    }
    bad.push(v);
    return t;
  });
  if (bad.length === 0 && fixed.some((f, i) => f !== values[i]!.trim().toLowerCase())) {
    // Auto-correct URL-shaped entries to their host and carry on.
    return { ok: true, domains: fixed };
  }
  if (bad.length === 0) return { ok: true, domains: fixed };
  return {
    ok: false,
    message: `${name} entries must be bare domains like "docs.python.org" (got ${bad.map((b) => JSON.stringify(b)).join(', ')}).`,
    hint: `Retry with ${name}: ${JSON.stringify(fixed.filter((f) => f.includes('.')))}.`,
  };
}
