/**
 * DOM pre-pass run before Readability / mdream so that code blocks and data tables survive
 * extraction with their fidelity intact:
 *
 * - highlighter markup (Prism / Shiki / highlight.js / Pygments `div.highlight`, `codehilite`,
 *   pandoc `sourceCode`, Docusaurus, Sphinx `linenos`) → `<pre><code class="language-x">` with
 *   the language recovered from `language-*` / `lang-*` / `highlight-*` / `data-lang(uage)` on the
 *   pre, code or wrapper; token spans flattened; per-line wrappers re-joined with newlines;
 * - line-number tables (Pygments `highlighttable`, Rouge, Chroma `lntable`, GitHub blob tables)
 *   → the code column only; Prism `line-numbers-rows`, Sphinx `.linenos` gutters removed;
 * - "Copy" buttons and other `<button>`s, heading self-links (`¶`, `#`, headerlink) removed;
 * - data-looking tables get a `summary` attribute so Readability's conditional cleaning keeps them
 *   (Readability treats `summary` as a data-table marker).
 *
 * All operations mutate the linkedom document in place and are best-effort (never throw).
 */

export interface PrepassStats {
  /** `<pre>` blocks present after normalisation. */
  preBlocks: number;
  /** Tables marked / present after normalisation. */
  tables: number;
  /** Highlighter blocks rewritten. */
  normalizedCode: number;
  /** Line-number tables collapsed to their code column. */
  lineNumberTables: number;
  /** `language-*` classes present after normalisation (pass to Readability's classesToPreserve). */
  languageClasses: string[];
}

const UI_NOISE_SELECTOR = [
  'button',
  'input[type="button"]',
  'input[type="submit"]',
  '.copy-button',
  '.copy-to-clipboard',
  '.copy-code-button',
  '.copyButton',
  '.clipboard-button',
  '[data-clipboard-target]',
  '[data-clipboard-text]',
  '.zeroclipboard-container',
  '.line-numbers-rows',
].join(',');

const HEADING_ANCHOR_SELECTOR = [
  'a.headerlink',
  'a.anchor-link',
  'a.hash-link',
  'a.header-anchor',
  'a.anchorjs-link',
  'a.heading-anchor',
  'a.mark',
  'h1 a[href^="#"]',
  'h2 a[href^="#"]',
  'h3 a[href^="#"]',
  'h4 a[href^="#"]',
  'h5 a[href^="#"]',
  'h6 a[href^="#"]',
].join(',');

/** Short code-block chrome ("css", "Copy", "Bash") shown above/below <pre>; removed when short. */
const CODE_LABEL_SELECTOR =
  '.example-header,.code-header,.code-block-header,.codeblock-header,.code-title,.language-name,.code-lang,.highlight-header,.snippet-header,.code-block__header,.code-block-title,.code-toolbar>.toolbar,.buttonGroup__atx';

const IN_PRE_NOISE_SELECTOR =
  '.linenos,.lineno,.line-number,.line-numbers,.ln,.hljs-ln-numbers,.hljs-ln-n,.gutter,.sr-only,[aria-hidden="true"],.copy,.clipboard';

const LINE_CLASS_RE =
  /(^|\s)(line|token-line|code-line|hljs-ln-line|cm-line|ec-line|highlight-line)(\s|$)/;
const LANG_CLASS_RE =
  /(?:^|\s)(?:(?:language|lang|highlight|hljs)[-:_]|(?:sourceCode|brush:)\s+)([a-z0-9#+_.-]+)/i;
const HEADING_ANCHOR_TEXT_RE =
  /^(?:#|¶|§|🔗|link|permalink|anchor|link to this (?:heading|section)|permalink to this (?:heading|headline|definition))?$/i;
const NUMERIC_CELL_RE = /^\s*\d*\s*$/;

export function prepassDocument(document: any): PrepassStats {
  const stats: PrepassStats = {
    preBlocks: 0,
    tables: 0,
    normalizedCode: 0,
    lineNumberTables: 0,
    languageClasses: [],
  };
  try {
    stripUiNoise(document);
  } catch {
    /* best effort */
  }
  try {
    stats.lineNumberTables = collapseLineNumberTables(document);
  } catch {
    /* best effort */
  }
  try {
    stats.normalizedCode = normalizeCodeBlocks(document);
  } catch {
    /* best effort */
  }
  try {
    markDataTables(document);
  } catch {
    /* best effort */
  }
  try {
    stats.preBlocks = document.querySelectorAll('pre').length;
    stats.tables = document.querySelectorAll('table').length;
    const langs = new Set<string>();
    for (const c of document.querySelectorAll('pre > code[class*="language-"]')) {
      const m = /(?:^|\s)(language-[^\s]+)/.exec(c.getAttribute('class') ?? '');
      if (m?.[1]) langs.add(m[1]);
    }
    stats.languageClasses = [...langs];
  } catch {
    /* best effort */
  }
  return stats;
}

/** Remove buttons, copy widgets, heading self-links and hidden gutters. */
export function stripUiNoise(document: any): void {
  for (const el of [...document.querySelectorAll(UI_NOISE_SELECTOR)]) el.remove();
  for (const el of [...document.querySelectorAll(CODE_LABEL_SELECTOR)]) {
    if (String(el.textContent ?? '').trim().length <= 40) el.remove();
  }
  // <dl>/<details> have no markdown form (mdream passes the tags through): rewrite as bold terms
  // + indented definitions / a bold summary + body so they read as text.
  for (const dt of [...document.querySelectorAll('dt')]) {
    const p = document.createElement('p');
    const b = document.createElement('strong');
    while (dt.firstChild) b.appendChild(dt.firstChild);
    p.appendChild(b);
    dt.replaceWith(p);
  }
  for (const el of [...document.querySelectorAll('dd,dl,details')]) {
    const div = document.createElement('div');
    while (el.firstChild) div.appendChild(el.firstChild);
    el.replaceWith(div);
  }
  for (const s of [...document.querySelectorAll('summary')]) {
    const p = document.createElement('p');
    const b = document.createElement('strong');
    while (s.firstChild) b.appendChild(s.firstChild);
    p.appendChild(b);
    s.replaceWith(p);
  }
  // Heading self-links: <h2>Title<a href="#title">#</a></h2> → drop the symbol;
  // <h2><a class="heading-anchor" href="#x">Title</a></h2> → keep the text, drop the link.
  for (const a of [...document.querySelectorAll(HEADING_ANCHOR_SELECTOR)]) {
    if (!document.contains(a)) continue;
    const t = (a.textContent ?? '').trim();
    if (HEADING_ANCHOR_TEXT_RE.test(t) || a.getAttribute('aria-hidden') === 'true') a.remove();
    else if (a.closest?.('h1,h2,h3,h4,h5,h6')) a.replaceWith(document.createTextNode(t));
  }
  for (const el of [...document.querySelectorAll('pre')]) {
    for (const n of [...el.querySelectorAll(IN_PRE_NOISE_SELECTOR)]) {
      // `.line` wrappers may carry aria-hidden on decorative copies; only remove short gutters/labels.
      if ((n.textContent ?? '').trim().length <= 8 || !LINE_CLASS_RE.test(n.className ?? ''))
        n.remove();
    }
  }
}

/**
 * Collapse two-column line-number tables (gutter + code) to a single `<pre>` holding the code
 * column, and GitHub-style one-row-per-line tables to a `<pre>` of joined lines.
 */
export function collapseLineNumberTables(document: any): number {
  let n = 0;
  for (const table of [...document.querySelectorAll('table')]) {
    if (!document.contains(table)) continue;
    const cls = String(table.className ?? '');
    const rows = [...table.querySelectorAll('tr')];
    if (rows.length === 0) continue;
    // Pygments/Rouge/Chroma: one row, gutter cell + code cell.
    if (rows.length === 1) {
      const cells = [...rows[0].children].filter((c: any) => /^t[dh]$/i.test(c.tagName));
      if (cells.length === 2) {
        const [gutter, code] = cells;
        const gutterCls = String(gutter.className ?? '');
        const codePre = code.querySelector('pre');
        if (
          codePre &&
          (/linenos|gutter|line-?numbers|lineno|rouge-gutter|lntd/i.test(gutterCls) ||
            /highlighttable|lntable|rouge-table|codehilitetable/i.test(cls) ||
            isNumericGutter(gutter))
        ) {
          table.replaceWith(codePre);
          n++;
          continue;
        }
      }
    }
    // GitHub blob / some wikis: every row = [line number, code].
    if (
      rows.length >= 2 &&
      rows.every((r: any) => r.children.length === 2 && isNumericGutter(r.children[0]))
    ) {
      const lines = rows.map((r: any) => (r.children[1].textContent ?? '').replace(/\n+$/, ''));
      const lang = detectLang(table);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (lang) code.setAttribute('class', `language-${lang}`);
      code.textContent = lines.join('\n');
      pre.appendChild(code);
      table.replaceWith(pre);
      n++;
    }
  }
  return n;
}

function isNumericGutter(cell: any): boolean {
  const txt = String(cell.textContent ?? '');
  if (!txt.trim()) return false;
  return txt
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .every((l) => NUMERIC_CELL_RE.test(l));
}

/** Rewrite every `<pre>` as `<pre><code class="language-x">flat text</code></pre>`. */
export function normalizeCodeBlocks(document: any): number {
  let n = 0;
  for (const pre of [...document.querySelectorAll('pre')]) {
    if (!document.contains(pre)) continue;
    // Skip <pre> that only wraps prose-y HTML? No: mdream fences every <pre>; we normalise all.
    for (const br of [...pre.querySelectorAll('br')]) br.replaceWith(document.createTextNode('\n'));
    const lang = detectLang(pre);
    const codeEl = pre.querySelector('code');
    const container = codeEl ?? pre;
    const lineEls = [...container.children].filter(
      (c: any) => LINE_CLASS_RE.test(String(c.className ?? '')) || c.tagName === 'DIV',
    );
    let text: string;
    if (lineEls.length >= 2 && lineEls.length >= container.children.length * 0.8) {
      text = lineEls.map((l: any) => String(l.textContent ?? '').replace(/\n$/, '')).join('\n');
    } else {
      text = String(container.textContent ?? '');
    }
    text = text.replace(/^\n+/, '').replace(/\s+$/, '');
    const hadSpans = container.querySelector('span,div,a,b,i,em,strong') !== null;
    const codeClass = codeEl?.getAttribute('class') ?? '';
    const alreadyClean =
      !hadSpans &&
      codeEl &&
      !pre.getAttribute('class') &&
      (!lang || /(^|\s)language-/.test(codeClass)) &&
      pre.children.length === 1;
    if (alreadyClean) continue;
    const code = document.createElement('code');
    if (lang) code.setAttribute('class', `language-${lang}`);
    code.textContent = text;
    while (pre.firstChild) pre.removeChild(pre.firstChild);
    pre.appendChild(code);
    for (const attr of [...(pre.attributes ?? [])]) pre.removeAttribute(attr.name);
    n++;
  }
  return n;
}

const LANG_ALIASES: Record<string, string> = {
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  py: 'python',
  python: 'python',
  py3: 'python',
  python3: 'python',
  rb: 'ruby',
  sh: 'sh',
  shell: 'sh',
  bash: 'bash',
  zsh: 'sh',
  console: 'sh',
  shellsession: 'sh',
  text: 'text',
  plaintext: 'text',
  plain: 'text',
  none: 'text',
  nohighlight: 'text',
  default: 'text',
  yml: 'yaml',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  html: 'html',
  markup: 'html',
  xml: 'xml',
  json: 'json',
  jsonc: 'json',
};

/** Language from the element, its `<code>` child, or up to 3 wrapper ancestors. */
export function detectLang(el: any): string | undefined {
  const candidates: any[] = [el];
  const code = el.querySelector?.('code');
  if (code) candidates.unshift(code);
  let p = el.parentElement;
  for (let i = 0; i < 3 && p; i++, p = p.parentElement) candidates.push(p);
  for (const c of candidates) {
    if (!c?.getAttribute) continue;
    for (const attr of ['data-language', 'data-lang', 'data-code-language', 'data-syntax']) {
      const v = c.getAttribute(attr);
      if (v && /^[a-z0-9#+_.-]{1,20}$/i.test(v.trim())) {
        const norm = normLang(v);
        if (norm) return norm;
      }
    }
    const cls = String(c.getAttribute('class') ?? '');
    const m = LANG_CLASS_RE.exec(cls);
    if (m?.[1]) {
      const norm = normLang(m[1]);
      if (norm && norm !== 'default') return norm;
    }
    // highlight.js often sets just the language as a class on <code class="hljs python">.
    if (c.tagName === 'CODE' && /(^|\s)hljs(\s|$)/.test(cls)) {
      const other = cls
        .split(/\s+/)
        .find((k: string) => k && k !== 'hljs' && /^[a-z0-9#+_.-]+$/i.test(k));
      if (other) return normLang(other);
    }
  }
  return undefined;
}

function normLang(v: string): string | undefined {
  const k = v
    .trim()
    .toLowerCase()
    .replace(/^(source|text)[.\-/]/, '');
  if (
    !k ||
    k.length > 20 ||
    /^(line-numbers|highlight|prism|shiki|hljs|code|pre|block|codeblock|snippet|numbers|wrap|copy|dark|light|github|monokai|nord|dracula|one-dark|vs|tab-size|notranslate|source|table)$/.test(
      k,
    )
  )
    return undefined;
  return LANG_ALIASES[k] ?? k;
}

/**
 * Tag tables that look like data tables with `summary` so Readability keeps them (it treats
 * `summary` as a data-table marker). Skips layout tables (nested, single row/column, presentation).
 */
export function markDataTables(document: any): number {
  let n = 0;
  for (const table of [...document.querySelectorAll('table')]) {
    if (table.getAttribute('role') === 'presentation' || table.getAttribute('summary')) continue;
    if (table.querySelector('table')) continue; // nested → layout
    if (table.closest?.('pre')) continue;
    const rows = [...table.querySelectorAll('tr')];
    if (rows.length < 2) continue;
    const widths = rows.map(
      (r: any) => [...r.children].filter((c: any) => /^t[dh]$/i.test(c.tagName)).length,
    );
    const cols = Math.max(...widths);
    if (cols < 2) continue;
    const consistent = widths.filter((w) => w === cols).length >= rows.length * 0.7;
    if (!consistent) continue;
    // Layout tables tend to hold long prose in one cell; data cells are short.
    const cells = [...table.querySelectorAll('td,th')];
    const long = cells.filter((c: any) => (c.textContent ?? '').trim().length > 400).length;
    if (long > cells.length * 0.2) continue;
    // Link-dense tables are navigation ("suggested topics", file lists), not data.
    const total =
      String(table.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim().length || 1;
    let linkText = 0;
    for (const a of table.querySelectorAll('a'))
      linkText += String(a.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim().length;
    if (linkText / total > 0.5) continue;
    table.setAttribute('summary', 'data table');
    n++;
  }
  return n;
}

/**
 * Old plain-text documents (rfc-editor, man pages) put the whole text in <pre> blocks. When such
 * blocks carry most of the page and read like prose, unwrap them into paragraphs (and headings for
 * numbered section lines) instead of one giant code fence.
 */
export function unwrapProsePre(document: any): boolean {
  const pres = [...document.querySelectorAll('pre')];
  if (pres.length === 0) return false;
  const preText = pres.reduce((a: number, p: any) => a + (p.textContent?.length ?? 0), 0);
  const bodyText = document.body?.textContent?.length ?? 0;
  if (bodyText === 0 || preText / bodyText < 0.6 || preText < 1500) return false;
  const sample = pres
    .map((p: any) => p.textContent ?? '')
    .join('\n')
    .slice(0, 20_000);
  const lines = sample.split('\n').filter((l) => l.trim());
  const proseLines = lines.filter(
    (l) => /^\s*[A-Z][a-z].*[a-z][.,;:)]?\s*$/.test(l) && !/[{};=<>]/.test(l),
  ).length;
  const symbolLines = lines.filter((l) => /[{}();=<>]/.test(l)).length;
  if (proseLines < lines.length * 0.35 || symbolLines > lines.length * 0.15) return false;
  for (const pre of pres) {
    const text = String(pre.textContent ?? '').replace(/\f/g, '\n');
    const frag = document.createElement('div');
    for (const block of text.split(/\n[ \t]*\n+/)) {
      const raw = block.replace(/^\n+|\n+$/g, '');
      if (!raw.trim()) continue;
      const blines = raw.split('\n');
      const heading = /^(\d+(?:\.\d+)*\.?)\s{1,3}(\S.{2,80})$/.exec(blines[0]!.trim());
      if (blines.length === 1 && heading && !/[.]$/.test(heading[2]!.trim())) {
        const level = Math.min(6, (heading[1]!.replace(/\.$/, '').split('.').length ?? 1) + 1);
        const h = document.createElement(`h${level}`);
        h.textContent = `${heading[1]} ${heading[2]}`.replace(/\s+/g, ' ').trim();
        frag.appendChild(h);
        continue;
      }
      // Running headers/footers ("Fielding, et al.   Standards Track   [Page 3]") → drop.
      if (blines.length === 1 && /\[Page \d+\]\s*$/.test(raw)) continue;
      if (blines.length === 1 && /^RFC \d+\s{2,}.*\s{2,}\S+ \d{4}\s*$/.test(raw.trim())) continue;
      const indents = blines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)?.[0].length ?? 0);
      const minIndent = Math.min(...indents);
      const dedented = blines.map((l) =>
        l.slice(Math.min(minIndent, l.match(/^\s*/)?.[0].length ?? 0)),
      );
      // Preformatted-looking blocks (deeper indentation, ascii art) keep their line structure.
      const looksPre =
        dedented.some((l) => /^\s{3,}/.test(l)) ||
        dedented.some((l) => /[|+]-{3,}|-{3,}[|+]/.test(l));
      if (looksPre) {
        const p = document.createElement('pre');
        p.textContent = dedented.join('\n');
        frag.appendChild(p);
      } else {
        const p = document.createElement('p');
        p.textContent = dedented.map((l) => l.trim()).join(' ');
        frag.appendChild(p);
      }
    }
    pre.replaceWith(...frag.childNodes);
  }
  return true;
}
