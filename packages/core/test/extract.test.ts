/**
 * Extraction regression corpus: every fixture in test/fixtures/extract is parsed with the default
 * parser chain and checked against its spec (failure code, char-trigram F1 vs gold/snapshot,
 * must-contain / must-not-contain, metadata, code/table survival). See the README there.
 *
 * Fixtures whose spec has `expectFail` are known gaps (`it.fails`): the test fails once they start
 * passing, which is the cue to remove the flag.
 *
 * `UPDATE_EXTRACT_SNAPSHOTS=1 npx vitest run packages/core/test/extract.test.ts` rewrites the
 * `*.snap.md` snapshots of real recorded pages after a deliberate extractor change.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { WebVectorError } from '../src/errors.js';
import { createParsers, selectParser } from '../src/ingest/parsers.js';
import type { ParsedDocument } from '../src/types.js';
import {
  type CorpusCase,
  charF1,
  countCodeBlocks,
  countTableRows,
  loadCorpus,
  writeSnapshot,
} from './helpers/extract-corpus.js';

const UPDATE = !!process.env.UPDATE_EXTRACT_SNAPSHOTS;
const parsers = createParsers();
const cases = loadCorpus();
const scores: { name: string; f1: number; parser: string }[] = [];

async function extract(
  c: CorpusCase,
): Promise<{ doc: ParsedDocument | null; code?: string; err?: WebVectorError }> {
  const bytes = new TextEncoder().encode(c.html);
  const contentType = c.spec.contentType ?? 'text/html';
  const parser = selectParser(parsers, contentType, c.spec.url, bytes);
  if (!parser) return { doc: null, code: 'UNSUPPORTED_CONTENT_TYPE' };
  try {
    const doc = await parser.parse(bytes, { url: c.spec.url, contentType });
    return doc ? { doc } : { doc: null, code: 'PARSE_EMPTY' };
  } catch (err) {
    if (err instanceof WebVectorError) return { doc: null, code: err.code, err };
    throw err;
  }
}

/** mdream escapes `[`/`*` etc. in prose; compare against both raw and unescaped markdown. */
function includes(md: string, needle: string): boolean {
  return md.includes(needle) || md.replace(/\\([\\[\]*_`#>|~-])/g, '$1').includes(needle);
}

describe('extraction corpus', () => {
  expect(cases.length).toBeGreaterThanOrEqual(30);

  for (const c of cases) {
    const spec = c.spec;
    const run = (spec as { expectFail?: string }).expectFail ? it.fails : it;
    run(`${c.name} — ${spec.type}`, async () => {
      const { doc, code } = await extract(c);
      if (spec.failure) {
        expect(doc).toBeNull();
        expect(code).toBe(spec.failure);
        return;
      }
      expect(code, `expected a document, got ${code}`).toBeUndefined();
      const md = (doc as ParsedDocument).markdown;
      const d = doc as ParsedDocument & Record<string, unknown>;

      // reference text: gold (ideal) for synthetic fixtures, accepted snapshot for real pages
      let ref = c.gold ?? c.snapshot;
      if (!c.gold && (UPDATE || !c.snapshot)) {
        writeSnapshot(c, md);
        ref = md;
      }
      expect(ref, 'no gold or snapshot for fixture').toBeDefined();
      const { f1, p, r } = charF1(md, ref as string);
      scores.push({ name: c.name, f1, parser: d.parser });
      if (spec.minF1 !== undefined) {
        expect(
          f1,
          `char-trigram F1 ${f1.toFixed(3)} (p=${p.toFixed(2)} r=${r.toFixed(2)}) < ${spec.minF1}`,
        ).toBeGreaterThanOrEqual(spec.minF1);
      }
      for (const s of spec.mustContain ?? [])
        expect(includes(md, s), `missing: ${JSON.stringify(s)}`).toBe(true);
      for (const s of spec.mustNotContain ?? [])
        expect(includes(md, s), `boilerplate leaked: ${JSON.stringify(s)}`).toBe(false);
      if (spec.minChars) expect(md.length).toBeGreaterThanOrEqual(spec.minChars);
      if (spec.minCodeBlocks)
        expect(countCodeBlocks(md), 'fenced code blocks').toBeGreaterThanOrEqual(
          spec.minCodeBlocks,
        );
      if (spec.minTableRows)
        expect(countTableRows(md), 'table rows').toBeGreaterThanOrEqual(spec.minTableRows);
      for (const [k, v] of Object.entries(spec.meta ?? {})) {
        if (typeof v === 'string') expect(String(d[k] ?? ''), `meta.${k}`).toContain(v);
        else expect(d[k], `meta.${k}`).toEqual(v);
      }
    });
  }

  afterAll(() => {
    if (!scores.length) return;
    const gold = scores.filter((s) => cases.find((c) => c.name === s.name)?.gold);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const worst = [...gold].sort((a, b) => a.f1 - b.f1).slice(0, 5);
    console.info(
      `extract corpus: ${cases.length} fixtures, mean F1 vs gold ${mean(gold.map((s) => s.f1)).toFixed(3)} (n=${gold.length}); worst: ${worst
        .map((s) => `${s.name}=${s.f1.toFixed(2)}`)
        .join(', ')}`,
    );
  });
});
