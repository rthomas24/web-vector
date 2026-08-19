import { describe, expect, it } from 'vitest';
import {
  excludeFromHtml,
  extractLinks,
  selectFromHtml,
  slicePage,
} from '../src/pipeline/fetch-options.js';
import { continuationSentence } from '../src/pipeline/fetch-tool.js';

const html = `<!doctype html><html><head><title>Docs</title></head><body>
<nav><a href="/home">Home</a><a href="https://other.example/x">Other</a></nav>
<div class="cookie">Accept cookies</div>
<main><article><h1>Guide</h1><p>Main paragraph about <a href="/deep">deep</a> things.</p>
<pre><code>x = 1</code></pre></article><aside id="related">Related posts</aside></main>
<footer><a href="mailto:a@b">mail</a><a href="#top">top</a><a href="/home">Home again</a></footer>
</body></html>`;

describe('fetch-options helpers', () => {
  it('selectFromHtml converts only the matched subtree (bypassing Readability)', () => {
    const doc = selectFromHtml(html, 'https://site.example/docs', 'main article');
    expect(doc?.parser).toBe('selector');
    expect(doc?.title).toBe('Docs');
    expect(doc?.markdown).toContain('# Guide');
    expect(doc?.markdown).toContain('x = 1');
    expect(doc?.markdown).not.toContain('Related posts');
    expect(doc?.markdown).not.toContain('Accept cookies');
    expect(selectFromHtml(html, 'https://site.example/docs', '#nope')).toBeNull();
    expect(selectFromHtml(html, 'https://site.example/docs', '<<bad')).toBeNull();
    const d2 = selectFromHtml(html, 'https://site.example/docs', 'main', {
      excludeSelectors: ['#related'],
    });
    expect(d2?.markdown).not.toContain('Related posts');
  });
  it('excludeFromHtml removes matches and tolerates bad selectors', () => {
    const out = excludeFromHtml(html, ['.cookie', '<<bad', 'aside']);
    expect(out).not.toContain('Accept cookies');
    expect(out).not.toContain('Related posts');
    expect(out).toContain('Main paragraph');
  });
  it('extractLinks dedupes, resolves relative URLs, drops mailto/#, same-host first, caps', () => {
    const links = extractLinks(html, 'https://site.example/docs');
    expect(links.map((l) => l.url)).toEqual([
      'https://site.example/home',
      'https://site.example/deep',
      'https://other.example/x',
    ]);
    expect(links[0]!.text).toBe('Home');
    expect(extractLinks(html, 'https://site.example/docs', 1)).toHaveLength(1);
  });
  it('slicePage cuts on a paragraph/heading boundary and reports continuation offsets', () => {
    const content = `${'para one. '.repeat(20)}\n\n## Heading\n${'para two. '.repeat(20)}\n\n${'para three. '.repeat(20)}`;
    const s1 = slicePage(content, 0, 260);
    expect(s1.truncated).toBe(true);
    expect(s1.text.endsWith('\n')).toBe(true);
    expect(s1.end).toBeLessThanOrEqual(260);
    expect(s1.end).toBeGreaterThanOrEqual(156); // ≥ 60 % of the window
    const s2 = slicePage(content, s1.end, 10_000);
    expect(s2.start).toBe(s1.end);
    expect(s2.truncated).toBe(false);
    expect(s1.text + s2.text).toBe(content);
    expect(slicePage(content, 99_999, 100)).toMatchObject({ text: '', truncated: false });
    expect(slicePage('a'.repeat(1000), 0, 100).text).toHaveLength(100); // no boundary → hard cut
    expect(continuationSentence(20000, 87412)).toBe(
      '_Content truncated at char 20000 of 87412. Call webvector_fetch with start_index=20000 to continue, or pass `query` to get only relevant passages._',
    );
  });
});
