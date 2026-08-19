/**
 * Page-level detectors used by the HTML parser: JavaScript-only shells (`PARSE_NEEDS_JS`) and
 * document language. Pure functions over the raw HTML string and the parsed (linkedom) document;
 * no network, no dependencies.
 */

export interface JsShellSignals {
  /**
   * Shell-like signals are present. The parser treats the page as a shell when the extracted
   * markdown is shorter than `maxMarkdownLength`.
   */
  suspected: boolean;
  /** Framework guessed from markers (informational). */
  framework?: string;
  /** Which signals fired, for error details and tests. */
  signals: string[];
  /** Length of the visible body text (whitespace-collapsed) at detection time. */
  bodyTextLength: number;
  /**
   * Extracted-markdown length below which the page is treated as a shell. Stronger evidence
   * tolerates more chrome text (a shell often still ships a server-rendered header/footer).
   */
  maxMarkdownLength: number;
}

const ROOT_SELECTOR =
  '#root,#app,#__next,#__nuxt,#___gatsby,#svelte,#q-app,#__docusaurus,app-root,[data-reactroot],[data-server-rendered]';

const MARKERS: [RegExp, string][] = [
  [/self\.__next_f\.push/, 'next-app'],
  [/id="__NEXT_DATA__"/, 'next'],
  [/__NUXT_DATA__|window\.__NUXT__/, 'nuxt'],
  [/\bng-version=/, 'angular'],
  [/___gatsby/, 'gatsby'],
  [/window\.__remixContext|data-sveltekit|__sveltekit/, 'remix/sveltekit'],
  [/data-reactroot|__REACT_DEVTOOLS_GLOBAL_HOOK__|\/static\/js\/main\.[0-9a-f]+\.js/, 'react'],
  [/data-v-app|__VUE__|__vite_ssr/, 'vue'],
];

const NOSCRIPT_RE =
  /(enable|turn on|activate|requires?|need to enable|must (?:be|have)|doesn't work without|does not work without|please enable)[^<]{0,40}javascript|javascript (?:is|must be) (?:required|disabled|enabled|turned on)|javascript app/i;

/**
 * Detect a JavaScript-rendered shell: an empty framework root container, a `<noscript>` telling
 * the visitor to enable JavaScript, or hydration/framework markers, each combined with a nearly
 * empty visible body. Call after `<script>`/`<style>`/`<template>` were removed from `document`.
 */
export function detectJsShell(rawHtml: string, document: any): JsShellSignals {
  const signals: string[] = [];
  let framework: string | undefined;
  for (const [re, name] of MARKERS) {
    if (re.test(rawHtml)) {
      signals.push(`marker:${name}`);
      framework ??= name;
    }
  }
  const noscriptHtml = rawHtml.match(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi) ?? [];
  const noscriptEnableJs = noscriptHtml.some((n) => NOSCRIPT_RE.test(n.replace(/<[^>]+>/g, ' ')));
  if (noscriptEnableJs) signals.push('noscript:enable-javascript');

  let rootEmpty = false;
  try {
    for (const el of document.querySelectorAll(ROOT_SELECTOR)) {
      const txt = collapse(el.textContent ?? '');
      // Empty, or a skeleton/loading placeholder ("Loading…", spinner labels).
      if (txt.length < 40 || /^(loading|please wait)/i.test(txt)) {
        rootEmpty = true;
        signals.push(`empty-root:${el.id ? `#${el.id}` : el.tagName.toLowerCase()}`);
        break;
      }
    }
  } catch {
    /* ignore selector errors */
  }

  const bodyTextLength = collapse(document.body?.textContent ?? '').length;
  const bytes = rawHtml.length;
  const textRatio = bytes ? bodyTextLength / bytes : 1;
  if (bytes > 5_000 && textRatio < 0.02) signals.push('text-ratio:<2%');

  const markers = signals.some((s) => s.startsWith('marker:'));
  let maxMarkdownLength = 0;
  if (rootEmpty && (markers || noscriptEnableJs)) maxMarkdownLength = 1500;
  else if (rootEmpty) maxMarkdownLength = 600;
  else if (markers || noscriptEnableJs) maxMarkdownLength = 300;
  else if (signals.includes('text-ratio:<2%') && bytes > 20_000) maxMarkdownLength = 200;

  return {
    suspected: maxMarkdownLength > 0,
    framework,
    signals,
    bodyTextLength,
    maxMarkdownLength,
  };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ─── language ────────────────────────────────────────────────────────────────

/** Normalise a BCP-47-ish tag ("en_US", "EN-us", "de-DE") to a short lower-case tag ("en-US"). */
export function normalizeLangTag(tag: string | null | undefined): string | undefined {
  if (!tag) return undefined;
  const t =
    tag
      .trim()
      .replace(/_/g, '-')
      .split(/[,;\s]/)[0] ?? '';
  const m = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?/i.exec(t);
  if (!m) return undefined;
  let out = (m[1] as string).toLowerCase();
  if (m[2]) out += `-${m[2][0]!.toUpperCase()}${m[2].slice(1).toLowerCase()}`;
  if (m[3]) out += `-${m[3].toUpperCase()}`;
  return out;
}

/**
 * Guess the language of `text` from its dominant Unicode script (no dependency; only scripts that
 * map to one language with high confidence). Returns undefined for Latin/Cyrillic/Arabic text,
 * where the script alone is ambiguous.
 */
export function guessLangFromScript(text: string): string | undefined {
  const sample = text.slice(0, 4000);
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let thai = 0;
  let hebrew = 0;
  let greek = 0;
  let devanagari = 0;
  let letters = 0;
  for (const ch of sample) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) letters++;
      continue;
    }
    letters++;
    if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) kana++;
    else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) han++;
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) hangul++;
    else if (cp >= 0x0e00 && cp <= 0x0e7f) thai++;
    else if (cp >= 0x0590 && cp <= 0x05ff) hebrew++;
    else if (cp >= 0x0370 && cp <= 0x03ff) greek++;
    else if (cp >= 0x0900 && cp <= 0x097f) devanagari++;
  }
  if (letters < 20) return undefined;
  const share = (n: number) => n / letters;
  if (share(kana) > 0.05) return 'ja';
  if (share(hangul) > 0.2) return 'ko';
  if (share(han) > 0.2) return 'zh';
  if (share(thai) > 0.2) return 'th';
  if (share(hebrew) > 0.2) return 'he';
  if (share(greek) > 0.2) return 'el';
  if (share(devanagari) > 0.2) return 'hi';
  return undefined;
}
