import { describe, expect, it } from 'vitest';
import {
  renderMarkdown,
  renderResearch,
  suggestedQueriesFor,
  textFragmentUrl,
  transformLinks,
} from '../src/pipeline/format.js';
import type { Passage, ResearchResult } from '../src/types.js';

function passage(index: number, text: string, extra: Partial<Passage> = {}): Passage {
  return {
    index,
    text,
    url: `https://site.example/p${index}`,
    title: `Page ${index}`,
    score: 1 - index / 100,
    chunkIndex: 0,
    startOffset: 0,
    endOffset: text.length,
    fetchedAt: '2026-01-01T00:00:00Z',
    matchedQueries: ['q'],
    citation: `[${index}] Page ${index} — https://site.example/p${index}`,
    publishedAt: '2025-05-05',
    ...extra,
  };
}

function result(passages: Passage[], extra: Partial<ResearchResult> = {}): ResearchResult {
  return {
    query: 'rank fusion',
    queries: ['rank fusion', 'reciprocal rank fusion', 'rank fusion formula'],
    passages,
    sources: passages.map((p, i) => ({
      url: p.url,
      title: p.title,
      status: 'ok' as const,
      chunks: i === 0 ? 20 : 2,
      passageIndices: [p.index],
      searchRank: i + 1,
    })),
    failures: [
      { url: 'https://down.example/x', code: 'FETCH_HTTP_ERROR', message: '500', stage: 'ingest' },
    ],
    stats: {
      search: { provider: 'p', attempts: [], resultCount: 0, ms: 1 },
      ingest: { requested: 1, fetched: 1, ok: 1, failed: 0, cached: 0, bytes: 0, ms: 1 },
      embed: {
        provider: '',
        model: 'bm25',
        dimensions: 0,
        chunks: 0,
        cached: 0,
        batches: 0,
        ms: 0,
      },
      retrieve: { candidates: 0, queries: 1, reranked: false, ms: 0 },
      totalMs: 2,
      warnings: [],
    },
    ...extra,
  };
}

describe('renderResearch: concise vs detailed', () => {
  const r = result([passage(1, 'Alpha text.'), passage(2, 'Beta text.')]);
  it('concise drops score/date lines, failures and stats; detailed keeps them', () => {
    const concise = renderMarkdown(r, { format: 'concise', includeStats: true });
    expect(concise).toContain('**[1]** Page 1 — <https://site.example/p1>\n> Alpha text.');
    expect(concise).not.toMatch(/score \d/);
    expect(concise).not.toContain('published');
    expect(concise).not.toContain('## Not fetched');
    expect(concise).not.toContain('total 2ms');
    expect(concise).toContain('## Sources');
    const detailed = renderMarkdown(r, { format: 'detailed', includeStats: true });
    expect(detailed).toContain('(published 2025-05-05, score 0.99)');
    expect(detailed).toContain('## Not fetched (1)');
    expect(detailed).toContain('total 2ms');
  });
  it('concise still shows "Not fetched" when every page failed', () => {
    const allFailed = result([], {
      sources: [
        {
          url: 'https://down.example/x',
          title: 'x',
          status: 'failed',
          chunks: 0,
          passageIndices: [],
          searchRank: 1,
        },
      ],
    });
    expect(renderMarkdown(allFailed, { format: 'concise' })).toContain('## Not fetched (1)');
  });
  it('flags sources with untapped depth and prints suggested follow-ups', () => {
    const md = renderMarkdown(r, { suggestedQueries: suggestedQueriesFor(r) });
    expect(md).toContain(
      '(19 more chunks; webvector_fetch(url, query="rank fusion") to read more)',
    );
    expect(md).not.toContain('(1 more chunks');
    expect(md).toContain('_Suggested follow-ups: reciprocal rank fusion · rank fusion formula_');
    expect(suggestedQueriesFor(r)).toEqual(['reciprocal rank fusion', 'rank fusion formula']);
    expect(
      renderMarkdown(r, { sourceDepthHints: false, fetchToolName: 'web_fetch' }),
    ).not.toContain('more chunks');
  });
});

describe('renderResearch: token budget + omission footer', () => {
  const r = result(Array.from({ length: 12 }, (_, i) => passage(i + 1, 'word '.repeat(300))));
  it('drops passages from the bottom and names them in an explicit footer', () => {
    const out = renderResearch(r, { maxTokens: 800 });
    expect(out.omitted.length).toBeGreaterThan(5);
    expect(out.omitted[0]).toBe(13 - out.omitted.length);
    expect(out.markdown).toMatch(
      new RegExp(
        `_${out.omitted.length} more passages omitted \\(indices ${out.omitted[0]}–12\\)\\. Call again with max_tokens ≥ ${out.requiredTokens} or webvector_fetch\\(url, query\\) for \\[${out.omitted[0]}\\]\\._`,
      ),
    );
    expect(out.requiredTokens % 500).toBe(0);
    expect(out.approxTokens).toBeLessThanOrEqual(1000);
    expect(renderResearch(r, { maxTokens: 800, omissionFooter: false }).markdown).not.toContain(
      'omitted',
    );
    expect(renderResearch(r).omitted).toEqual([]);
  });
});

describe('link policy and deep links', () => {
  it('strip: links → text, images → [image: alt], code untouched', () => {
    const t =
      'See [the docs](https://d.example/x "t") and ![diagram](https://i.example/a.png) `[a](b)`\n```\n[c](d)\n```';
    const { text } = transformLinks(t, 'strip');
    expect(text).toBe('See the docs and [image: diagram] `[a](b)`\n```\n[c](d)\n```');
  });
  it('footnote: numbered footnotes per passage, deduped by url', () => {
    const { text, footnotes } = transformLinks(
      '[a](https://x/1) [b](https://x/2) [c](https://x/1)',
      'footnote',
    );
    expect(text).toBe('a[^1] b[^2] c[^1]');
    expect(footnotes).toEqual(['[^1]: https://x/1', '[^2]: https://x/2']);
    const md = renderMarkdown(result([passage(1, 'Read [this](https://x/1).')]), {
      links: 'footnote',
    });
    expect(md).toContain('> Read this[^1].\n[^1]: https://x/1');
    expect(
      renderMarkdown(result([passage(1, 'Read [this](https://x/1).')]), { links: 'inline' }),
    ).toContain('[this](https://x/1)');
  });
  it('deep links: text fragment from first/last words, percent-encoded, PDFs skipped', () => {
    const text =
      'Reciprocal rank-fusion combines, ranked lists from several systems into one final ordering.';
    const u = textFragmentUrl('https://s.example/p#old', text);
    expect(u).toBe(
      'https://s.example/p#:~:text=Reciprocal%20rank%2Dfusion%20combines%2C%20ranked%20lists,systems%20into%20one%20final%20ordering.',
    );
    expect(textFragmentUrl('https://s.example/p', 'short one')).toBe('https://s.example/p');
    const md = renderMarkdown(result([passage(1, text)]), { deepLinks: true });
    expect(md).toContain('<https://site.example/p1#:~:text=');
    const pdf = result([passage(1, text, { url: 'https://s.example/paper.pdf' })]);
    expect(renderMarkdown(pdf, { deepLinks: true })).toContain('<https://s.example/paper.pdf>');
  });
});
