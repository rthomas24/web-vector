/**
 * Content recovery for pages whose DOM carries too little text:
 *
 * - `prestripScripts()` runs on the raw HTML before linkedom: `<script>` bodies over ~16 KB are
 *   removed (a 400 KB–2 MB SSR page parses in a fraction of the time and memory), JSON-LD is kept,
 *   and framework payloads (`__NEXT_DATA__`, `self.__next_f.push` RSC chunks, `__NUXT_DATA__`) are
 *   stashed;
 * - `recoverFromStash()` walks the stashed JSON for the longest sentence-like `content` / `body` /
 *   `html` / `markdown` / `text` / `description` field (≥ 500 chars) — used only when the DOM
 *   extraction is thin, never instead of good DOM output;
 * - `recoverArticleBody()` returns the JSON-LD `articleBody` when the page is not paywalled
 *   (`isAccessibleForFree !== false`, including `hasPart`) — the caller applies the same
 *   thin-DOM rule.
 */
import { htmlToMarkdown } from 'mdream';

export interface ScriptStash {
  /** `<script id="__NEXT_DATA__">` JSON text. */
  nextData?: string;
  /** Concatenated `self.__next_f.push([1, "…"])` payload strings (React Server Components). */
  nextFlight?: string;
  /** `<script id="__NUXT_DATA__">` JSON text. */
  nuxtData?: string;
  /** Bytes removed from the HTML before parsing. */
  strippedBytes: number;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const FLIGHT_PUSH_RE = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;

/**
 * Remove large script bodies from raw HTML and stash framework data payloads. Returns the lighter
 * HTML plus the stash. Scripts under `minBytes` are left alone (linkedom + STRIP_SELECTOR handle
 * them); `application/ld+json` is always kept.
 */
export function prestripScripts(
  html: string,
  minBytes = 16 * 1024,
): { html: string; stash: ScriptStash } {
  const stash: ScriptStash = { strippedBytes: 0 };
  let flight = '';
  const out = html.replace(SCRIPT_RE, (m, attrs: string, body: string) => {
    const a = attrs.toLowerCase();
    if (a.includes('ld+json')) return m;
    if (a.includes('__next_data__')) {
      stash.nextData ??= body;
      stash.strippedBytes += body.length;
      return '<script></script>';
    }
    if (a.includes('__nuxt_data__')) {
      stash.nuxtData ??= body;
      stash.strippedBytes += body.length;
      return '<script></script>';
    }
    if (body.includes('self.__next_f.push')) {
      for (const f of body.matchAll(FLIGHT_PUSH_RE)) {
        try {
          flight += JSON.parse(f[1] as string);
        } catch {
          /* skip malformed chunk */
        }
      }
      // Keep tiny push scripts (markers for JS-shell detection use the raw HTML anyway).
      if (body.length < minBytes) return m;
      stash.strippedBytes += body.length;
      return '<script>self.__next_f.push([0])</script>';
    }
    if (body.length >= minBytes) {
      stash.strippedBytes += body.length;
      return '<script></script>';
    }
    return m;
  });
  if (flight) stash.nextFlight = flight;
  return { html: out, stash };
}

const CONTENT_KEY_RE =
  /^(content|body|html|markdown|md|text|description|articleBody|bodyHtml|contentHtml|rawContent|renderedContent|excerpt|summary|value|children)$/i;

/** Sentence-like: several sentence terminators or paragraph tags; not a URL soup or JSON blob. */
function sentenceLike(s: string): boolean {
  if (s.length < 500) return false;
  const sentences = (s.match(/[.!?。](\s|$|<)/g) ?? []).length;
  const tags = (s.match(/<\/?(p|h[1-6]|li|br)\b/gi) ?? []).length;
  if (sentences < 3 && tags < 3) return false;
  const words = s.split(/\s+/).length;
  if (words < 60) return false;
  const urlish = (s.match(/https?:\/\//g) ?? []).length;
  if (urlish > words / 10) return false;
  if (/^\s*[[{]/.test(s) && /[\]}]\s*$/.test(s)) return false;
  return true;
}

/** Longest sentence-like string under a content-ish key anywhere in `value` (depth/node capped). */
export function longestContentField(value: unknown, minChars = 500): string | undefined {
  let best: string | undefined;
  let nodes = 0;
  const visit = (v: unknown, key: string | undefined, depth: number) => {
    if (nodes++ > 50_000 || depth > 40 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (
        v.length >= minChars &&
        (!best || v.length > best.length) &&
        (key === undefined || CONTENT_KEY_RE.test(key)) &&
        sentenceLike(v)
      )
        best = v;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, k, depth + 1);
    }
  };
  visit(value, undefined, 0);
  return best;
}

/** Parse the React Flight (RSC) text protocol into JSON values + `T` text chunks. */
function flightValues(flight: string): unknown[] {
  const out: unknown[] = [];
  const texts: string[] = [];
  for (const line of flight.split('\n')) {
    const m = /^([0-9a-f]+):(.*)$/s.exec(line);
    if (!m) continue;
    const payload = m[2] as string;
    if (/^T[0-9a-f]+,/.test(payload)) {
      texts.push(payload.replace(/^T[0-9a-f]+,/, ''));
      continue;
    }
    if (/^[[{"]/.test(payload)) {
      try {
        out.push(JSON.parse(payload));
      } catch {
        /* partial line */
      }
    }
  }
  if (texts.length) out.push({ text: texts.join('\n\n') });
  return out;
}

/** Best recoverable text from stashed framework payloads, converted to markdown. */
export function recoverFromStash(
  stash: ScriptStash,
  tidy: (md: string) => string,
  minChars = 500,
): { markdown: string; source: 'next-data' | 'next-flight' | 'nuxt-data' } | undefined {
  const tryValue = (v: unknown, source: 'next-data' | 'next-flight' | 'nuxt-data') => {
    const s = longestContentField(v, minChars);
    if (!s) return undefined;
    const md = tidy(/<\/?(p|div|h[1-6]|li|br|ul|ol|table|pre)\b/i.test(s) ? htmlToMarkdown(s) : s);
    return md.length >= minChars ? { markdown: md, source } : undefined;
  };
  if (stash.nextData) {
    try {
      const r = tryValue(JSON.parse(stash.nextData), 'next-data');
      if (r) return r;
    } catch {
      /* ignore */
    }
  }
  if (stash.nuxtData) {
    try {
      const r = tryValue(JSON.parse(stash.nuxtData), 'nuxt-data');
      if (r) return r;
    } catch {
      /* ignore */
    }
  }
  if (stash.nextFlight) {
    const r = tryValue(flightValues(stash.nextFlight), 'next-flight');
    if (r) return r;
  }
  return undefined;
}

/**
 * JSON-LD `articleBody` as markdown when the page is not paywalled. `accessibleForFree === false`
 * (declared on the work or any `hasPart`) blocks recovery outright — that would be paywall
 * circumvention dressed as metadata.
 */
export function recoverArticleBody(
  articleBody: string | undefined,
  accessibleForFree: boolean | undefined,
  tidy: (md: string) => string,
  minChars = 500,
): string | undefined {
  if (!articleBody || accessibleForFree === false) return undefined;
  const body = articleBody.trim();
  if (body.length < minChars) return undefined;
  const md = tidy(/<\/?(p|div|h[1-6]|li|br)\b/i.test(body) ? htmlToMarkdown(body) : body);
  return md.length >= minChars ? md : undefined;
}
