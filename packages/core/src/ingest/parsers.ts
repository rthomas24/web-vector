import { Readability } from '@mozilla/readability';
import { decodeBuffer } from 'encoding-sniffer';
import { parseHTML } from 'linkedom';
import { htmlToMarkdown } from 'mdream';
import { WebVectorError } from '../errors.js';
import type { ContentParser, ParseContext, ParsedDocument } from '../types.js';
import { detectJsShell, guessLangFromScript, type JsShellSignals } from './extract-detect.js';
import {
  articleCandidate,
  type Candidate,
  type Choice,
  candidateFrom,
  chooseCandidate,
  classifyPageType,
  fullCandidate,
  type PageType,
  stripObviousChrome,
} from './extract-ensemble.js';
import { extractMeta } from './extract-meta.js';
import { prepassDocument } from './extract-prepass.js';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Convert markdown to plain text (headings/links/emphasis stripped) for BM25 and previews. */
export function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*\n?/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\|/g, ' ')
    .replace(/^-{3,}$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Characters stripped from all text we return: C0/C1 controls (keeping \t and \n), zero-width and
// bidi/format controls, line/paragraph separators, BOM. Built from code points so the source has
// no invisible characters or control escapes.
const STRIPPED_RANGES: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const hex4 = (n: number) => `\\u${n.toString(16).padStart(4, '0')}`;
const CONTROL_CHARS = new RegExp(
  `[${STRIPPED_RANGES.map(([a, b]) => `${hex4(a)}-${hex4(b)}`).join('')}]`,
  'gu',
);

/** Remove control characters (keep \n \t) and normalise whitespace lightly. */

export function sanitizeText(s: string): string {
  return s
    .replace(CONTROL_CHARS, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]{3,}/g, '  ');
}

/** One-line, length-capped, sanitised metadata field (title, byline, site name, dates…). */
export function cleanField(s: string | null | undefined, max = 300): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = sanitizeText(s).replace(/\s+/g, ' ').trim().slice(0, max);
  return t || undefined;
}

export function decodeBytes(bytes: Uint8Array, charset?: string): string {
  try {
    return decodeBuffer(Buffer.from(bytes), {
      transportLayerEncodingLabel: charset,
      defaultEncoding: 'utf-8',
    });
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/** Sanitise + light whitespace clean-up; fenced code blocks keep their indentation verbatim. */
export function tidyMarkdown(md: string): string {
  const parts = md.replace(/\r\n?/g, '\n').split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m);
  const out = parts.map((part, i) =>
    i % 2 === 1
      ? part.replace(CONTROL_CHARS, '')
      : sanitizeText(part)
          .replace(/\\?\[\s*\[edit\]\([^)]*\)\s*\\?\]/g, '') // Wikipedia [edit] links
          .replace(/\[\]\([^)]*\)/g, '') // empty links
          .replace(/\s*\[(?:#|¶|§)\]\([^)]*\)/g, '') // heading self-links that survived the DOM pass
          .replace(/[ \t]+$/gm, ''),
  );
  return out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── HTML ───────────────────────────────────────────────────────────────────

export interface HtmlParserOptions {
  /** Readability charThreshold (default 200). */
  charThreshold?: number;
  /** Minimum markdown length to accept Readability output before falling back (default 300). */
  minArticleChars?: number;
  /** Minimum length to consider a page non-empty (default 80). */
  minPageChars?: number;
  /** Try `defuddle` (optional peer) when the chosen extraction is still thin. */
  useDefuddle?: boolean;
  /**
   * `auto` (default): route by page type (Q&A/forum and docs pages use the whole main content,
   * <pre> documents are unwrapped, articles run Readability with a recall guard against the full
   * page); `readability`: classic Readability with whole-page fallback only when thin; `full`:
   * always the whole page (chrome removed).
   */
  strategy?: 'auto' | 'readability' | 'full';
}

const STRIP_SELECTOR =
  'template,script,style,noscript,svg,iframe,canvas,object,embed,link[rel="stylesheet"]';

export class HtmlParser implements ContentParser {
  readonly id = 'html';
  constructor(private readonly opts: HtmlParserOptions = {}) {}

  canHandle(contentType: string, url: string, sniff?: Uint8Array): boolean {
    if (/^(text\/html|application\/xhtml\+xml)/.test(contentType)) return true;
    if (contentType === '' || contentType === 'application/octet-stream') {
      if (/\.(html?|php|aspx?|jsp)(\?|$)/i.test(url)) return true;
      if (sniff) {
        const head = new TextDecoder('latin1').decode(sniff.subarray(0, 512)).toLowerCase();
        return /<!doctype html|<html|<head|<body/.test(head);
      }
    }
    return false;
  }

  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParsedDocument | null> {
    const html = decodeBytes(bytes, ctx.charset);
    return this.parseHtml(html, ctx.url, ctx.contentType || 'text/html');
  }

  async parseHtml(
    html: string,
    url: string,
    contentType = 'text/html',
  ): Promise<ParsedDocument | null> {
    const minArticle = this.opts.minArticleChars ?? 300;
    const minPage = this.opts.minPageChars ?? 80;
    // Fragments without <html>/<body> (old rfc-editor pages start with <pre>) lose most nodes in
    // linkedom unless wrapped.
    if (!/<(?:html|body)[\s>]/i.test(html)) html = `<html><body>${html}</body></html>`;
    const { document } = parseHTML(html);
    // Meta before mutation
    const meta = extractMeta(document, url);
    // Inject <base> so Readability resolves relative URLs (linkedom has no document URL)
    try {
      const head = document.head ?? document.querySelector('head') ?? document.documentElement;
      if (head && !document.querySelector('base[href]')) {
        const base = document.createElement('base');
        base.setAttribute('href', url);
        head.insertBefore(base, head.firstChild);
      }
    } catch {
      /* ignore */
    }
    // Strip non-content nodes (also fixes linkedom <template> leak)
    for (const el of [...document.querySelectorAll(STRIP_SELECTOR)]) el.remove();
    // JS-shell signals (empty #root, "enable JavaScript", hydration markers); decided at the end
    // against the amount of content actually extracted.
    const js = detectJsShell(html, document);
    // Code/table fidelity pre-pass: highlighter soup → <pre><code class="language-x">, copy
    // buttons and heading anchors removed, data tables marked so Readability keeps them.
    const prepass = prepassDocument(document);
    // Cookie walls, recommendation rails, share bars, flash notices: chrome on every page type.
    stripObviousChrome(document);

    // ── extractor ensemble + page-type routing ───────────────────────────
    const strategy = this.opts.strategy ?? 'auto';
    const pageType: PageType = classifyPageType(document, meta);
    const runReadability = (): ReturnType<Readability['parse']> | null => {
      try {
        const clone = document.cloneNode(true) as unknown as Document;
        return new Readability(clone as any, {
          charThreshold: this.opts.charThreshold ?? 200,
          keepClasses: false,
          // Readability strips classes; keep the language markers so mdream emits fenced blocks.
          classesToPreserve: prepass.languageClasses,
        }).parse();
      } catch {
        return null;
      }
    };
    const fullOpts = {
      url,
      tidy: tidyMarkdown,
      mainOnly: pageType === 'docs',
      unwrapPre: pageType === 'pre',
    };
    let article: ReturnType<Readability['parse']> | null = null;
    let readabilityCand: Candidate | undefined;
    let fullCand: Candidate | undefined;
    let choice: Choice | undefined;
    if (strategy === 'readability' || (strategy === 'auto' && pageType === 'article')) {
      article = runReadability();
      if (article?.content)
        readabilityCand = candidateFrom(
          'readability',
          tidyMarkdown(htmlToMarkdown(article.content, { origin: url })),
        );
    }
    if (strategy === 'readability') {
      // Classic behaviour: Readability, whole document only when the article is too thin.
      if (!readabilityCand || readabilityCand.textLen < minArticle)
        fullCand = fullCandidate(document, { ...fullOpts, mainOnly: false });
      choice = chooseCandidate({
        readability: readabilityCand,
        full: fullCand,
        minArticleChars: minArticle,
      });
    } else if (strategy === 'full' || pageType !== 'article') {
      // Forums / Q&A (Readability deletes answers), docs (main container), <pre> documents.
      fullCand = fullCandidate(document, fullOpts);
      if (!fullCand || fullCand.textLen < minArticle) {
        article ??= runReadability();
        if (article?.content)
          readabilityCand = candidateFrom(
            'readability',
            tidyMarkdown(htmlToMarkdown(article.content, { origin: url })),
          );
      }
      choice =
        fullCand && (!readabilityCand || fullCand.textLen >= readabilityCand.textLen * 0.5)
          ? { candidate: fullCand, guard: undefined }
          : chooseCandidate({
              readability: readabilityCand,
              full: fullCand,
              minArticleChars: minArticle,
            });
    } else {
      // Article: both candidates, Readability unless the recall guard says it dropped too much
      // (or a single clean <article> exists and Readability's pick is link-heavy around it).
      fullCand = fullCandidate(document, fullOpts);
      choice = chooseCandidate({
        readability: readabilityCand,
        full: fullCand,
        article: articleCandidate(document, fullOpts),
        minArticleChars: minArticle,
      });
    }
    let markdown = choice?.candidate.markdown ?? '';
    let parser = choice
      ? `${choice.candidate.name}${choice.guard ? `:${choice.guard}` : ''}`
      : 'none';
    if (choice?.candidate.name === 'readability' && !article) parser = 'readability';

    // Optional: defuddle (peer) when the chosen text is still thin.
    if (this.opts.useDefuddle && markdown.length < minArticle) {
      try {
        const spec = 'defuddle/node';
        const mod: any = await import(/* @vite-ignore */ spec);
        const r = await mod.Defuddle(document as any, url, { markdown: true, useAsync: false });
        if (r?.content && r.content.length > markdown.length) {
          markdown = tidyMarkdown(r.content);
          parser = 'defuddle';
          if (!meta.title && r.title) meta.title = r.title;
          if (!meta.publishedAt && r.published) meta.publishedAt = r.published;
        }
      } catch {
        /* optional */
      }
    }
    // Drop frontmatter mdream may add
    markdown = markdown.replace(/^---\n[\s\S]*?\n---(?:\n+|$)/, '').trim();
    if (js.suspected && markdown.length < js.maxMarkdownLength) throw needsJsError(url, js);
    if (markdown.length < minPage) return null;

    const title =
      (article?.title || meta.title || document.title || '').trim() ||
      firstHeading(document, markdown) ||
      hostTitle(url);
    const text = markdownToText(markdown);
    const lang = meta.lang ?? cleanField(article?.lang, 16) ?? guessLangFromScript(text);
    return {
      url,
      title: cleanField(title) ?? hostTitle(url),
      markdown,
      text,
      byline: cleanField(meta.byline ?? article?.byline, 200),
      siteName: cleanField(meta.siteName ?? article?.siteName, 120) ?? hostTitle(url),
      publishedAt: cleanField(meta.publishedAt ?? article?.publishedTime, 64),
      updatedAt: cleanField(meta.updatedAt, 64),
      lang: cleanField(lang, 16),
      excerpt: cleanField(article?.excerpt ?? meta.description, 500),
      canonicalUrl: meta.canonicalUrl,
      alternates: meta.alternates,
      kind: meta.kind,
      accessibleForFree: meta.accessibleForFree,
      wordCount: countWords(text),
      contentType,
      parser,
    };
  }
}

/** Whitespace-token count (CJK runs count per character). */
export function countWords(text: string): number {
  let n = 0;
  for (const tok of text.split(/\s+/)) {
    if (!tok) continue;
    const cjk = tok.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
    n += cjk ? cjk + (tok.length > cjk ? 1 : 0) : 1;
  }
  return n;
}

/** PARSE_NEEDS_JS: the page is a client-rendered shell; name the render hook in the remediation. */
export function needsJsError(url: string, js: JsShellSignals): WebVectorError {
  return new WebVectorError(
    `Page requires JavaScript to render${js.framework ? ` (${js.framework})` : ''}; no readable content in the served HTML of ${url}.`,
    {
      code: 'PARSE_NEEDS_JS',
      stage: 'ingest',
      remediation:
        "Configure a renderer with `ingestion.render` ({ provider: 'cloudflare' | 'browserless' | 'custom', when: 'needs-js' }) or use a search provider that returns page content.",
      details: { signals: js.signals, framework: js.framework, bodyTextLength: js.bodyTextLength },
    },
  );
}

/** Title fallback for pages without <title>/og:title: first <h1>, `.h1` (rfc-editor), first heading. */
function firstHeading(document: any, markdown: string): string | undefined {
  try {
    const h = document.querySelector('h1,.h1,h2');
    const t = cleanField(h?.textContent, 200);
    if (t) return t;
  } catch {
    /* ignore */
  }
  const m = /^#{1,3}\s+(.+)$/m.exec(markdown);
  return m ? cleanField(m[1], 200) : undefined;
}

function hostTitle(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ─── PDF ────────────────────────────────────────────────────────────────────

export class PdfParser implements ContentParser {
  readonly id = 'pdf';
  constructor(private readonly opts: { maxPages?: number } = {}) {}
  canHandle(contentType: string, url: string, sniff?: Uint8Array): boolean {
    if (/^application\/(pdf|x-pdf)/.test(contentType)) return true;
    if (/\.pdf(\?|$)/i.test(url)) return true;
    if (sniff && sniff.length >= 5)
      return (
        sniff[0] === 0x25 &&
        sniff[1] === 0x50 &&
        sniff[2] === 0x44 &&
        sniff[3] === 0x46 &&
        sniff[4] === 0x2d
      ); // %PDF-
    return false;
  }
  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParsedDocument | null> {
    let unpdf: typeof import('unpdf');
    try {
      unpdf = await import('unpdf');
    } catch (err) {
      throw new WebVectorError('PDF parsing requires the `unpdf` package.', {
        code: 'MISSING_DEPENDENCY',
        remediation: 'npm i unpdf',
        cause: err,
      });
    }
    let doc: Awaited<ReturnType<typeof unpdf.getDocumentProxy>>;
    try {
      doc = await unpdf.getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false } as any);
    } catch (err) {
      throw new WebVectorError(
        `Failed to open PDF ${ctx.url}: ${err instanceof Error ? err.message : err}`,
        { code: 'PARSE_FAILED', stage: 'ingest', cause: err },
      );
    }
    const maxPages = this.opts.maxPages ?? 200;
    const totalPages = doc.numPages;
    const used: string[] = [];
    let title = '';
    let byline: string | undefined;
    let publishedAt: string | undefined;
    try {
      // Extract page by page up to the cap (never all pages of a hostile 100k-page file).
      for (let n = 1; n <= Math.min(totalPages, maxPages); n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        used.push(
          content.items
            .map((it: any) => (typeof it.str === 'string' ? it.str + (it.hasEOL ? '\n' : '') : ''))
            .join(''),
        );
        page.cleanup?.();
      }
      try {
        const { info } = await unpdf.getMeta(doc, { parseDates: true } as any);
        const i = info as any;
        title = cleanField(i?.Title) ?? '';
        byline = cleanField(i?.Author, 200);
        const d = i?.CreationDate;
        if (d instanceof Date && !Number.isNaN(d.getTime())) publishedAt = d.toISOString();
        else if (typeof d === 'string') publishedAt = pdfDate(d);
      } catch {
        /* metadata is optional */
      }
    } finally {
      // Release pdf.js transport/worker memory (API differs slightly across pdf.js versions).
      const d = doc as any;
      await Promise.resolve(d.loadingTask?.destroy?.() ?? d.destroy?.() ?? d.cleanup?.()).catch(
        () => {},
      );
    }
    const markdown = tidyMarkdown(
      used
        .map((p, i) => `${normalizePdfPage(p)}${i < used.length - 1 ? '\n\n---\n\n' : ''}`)
        .join(''),
    );
    if (markdown.replace(/[-\s]/g, '').length < 40) return null;
    if (!title) {
      // Heuristic: first short line without terminal punctuation among the opening lines (paper titles).
      const lines = markdown
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 20);
      const cand =
        lines.find(
          (l) =>
            l.length >= 8 &&
            l.length <= 150 &&
            !/[.:;,]$/.test(l) &&
            !/^(abstract|arxiv|doi|https?:)/i.test(l),
        ) ?? lines.find((l) => l.length > 4 && l.length < 200);
      title = cand ?? hostTitle(ctx.url);
    }
    return {
      url: ctx.url,
      title: cleanField(title) ?? hostTitle(ctx.url),
      markdown,
      text: markdownToText(markdown),
      byline,
      publishedAt,
      contentType: 'application/pdf',
      parser: `unpdf(${totalPages}p)`,
    };
  }
}

function normalizePdfPage(p: string): string {
  return p
    .replace(/[ \t]+\n/g, '\n')
    .replace(/(\S)-\n(\S)/g, '$1$2') // de-hyphenate line breaks
    .replace(/([^\n.!?:])\n(?!\n)([a-z0-9(])/g, '$1 $2') // join wrapped lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pdfDate(s: string): string | undefined {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?/.exec(s);
  if (!m) return undefined;
  return `${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}`;
}

// ─── Plain text / markdown / json ───────────────────────────────────────────

export class TextParser implements ContentParser {
  readonly id = 'text';
  canHandle(contentType: string, url: string): boolean {
    return (
      /^(text\/(plain|markdown|x-markdown|csv|x-rst)|application\/(json|ld\+json|xml|rss\+xml|atom\+xml)|text\/xml)/.test(
        contentType,
      ) || /\.(md|markdown|txt|rst|json)(\?|$)/i.test(url)
    );
  }
  async parse(bytes: Uint8Array, ctx: ParseContext): Promise<ParsedDocument | null> {
    let text = decodeBytes(bytes, ctx.charset).replace(/\r\n?/g, '\n');
    let contentType = ctx.contentType || 'text/plain';
    // Strip YAML frontmatter, keeping title/description
    let fmTitle: string | undefined;
    let fmDescription: string | undefined;
    const fm = /^\uFEFF?---\n([\s\S]*?)\n---\n+/.exec(text);
    if (fm) {
      fmTitle = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1] as string)?.[1];
      fmDescription = /^description:\s*["']?(.+?)["']?\s*$/m.exec(fm[1] as string)?.[1];
      text = text.slice(fm[0].length);
    }
    if (/json/.test(contentType) || /\.json(\?|$)/i.test(ctx.url)) {
      try {
        text = `\`\`\`json\n${JSON.stringify(JSON.parse(text), null, 2).slice(0, 200_000)}\n\`\`\``;
        contentType = 'application/json';
      } catch {
        /* keep raw */
      }
    } else if (/xml/.test(contentType)) {
      // crude tag strip for feeds
      text = text
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
    }
    const markdown = tidyMarkdown(text);
    if (markdown.length < 40) return null;
    const head = markdown.split('\n').slice(0, 30);
    const heading = head
      .find((l) => /^#\s+\S/.test(l))
      ?.replace(/^#+\s*/, '')
      .trim();
    const firstLine =
      head
        .find((l) => l.trim() && !/^[-*_]{3,}$/.test(l.trim()))
        ?.replace(/^#+\s*/, '')
        .trim() ?? '';
    const candidate = fmTitle ?? heading ?? firstLine;
    return {
      url: ctx.url,
      title: (candidate.length > 3 && candidate.length < 200
        ? candidate
        : hostTitle(ctx.url)
      ).slice(0, 300),
      markdown,
      text: markdownToText(markdown),
      excerpt: fmDescription,
      contentType,
      parser: 'text',
    };
  }
}

/** Default parser chain by name. */
export function createParsers(
  names: string[] = ['html', 'pdf', 'text'],
  htmlOpts?: HtmlParserOptions,
): ContentParser[] {
  const out: ContentParser[] = [];
  for (const n of names) {
    if (n === 'html') out.push(new HtmlParser(htmlOpts));
    else if (n === 'pdf') out.push(new PdfParser());
    else if (n === 'text') out.push(new TextParser());
  }
  return out;
}

/** Choose the parser for a fetched resource. */
export function selectParser(
  parsers: ContentParser[],
  contentType: string,
  url: string,
  bytes: Uint8Array,
): ContentParser | undefined {
  const sniff = bytes.subarray(0, 1024);
  return parsers.find((p) => p.canHandle(contentType, url, sniff));
}
