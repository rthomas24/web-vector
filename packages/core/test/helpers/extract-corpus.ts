/**
 * Helpers for the extraction regression corpus (test/fixtures/extract). See the README there.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { markdownToText } from '../../src/ingest/parsers.js';

export const CORPUS_DIR = join(import.meta.dirname, '..', 'fixtures', 'extract');

export interface CorpusSpec {
  url: string;
  type: string;
  contentType?: string;
  failure?: string;
  minF1?: number;
  mustContain?: string[];
  mustNotContain?: string[];
  meta?: Record<string, unknown>;
  minChars?: number;
  minCodeBlocks?: number;
  minTableRows?: number;
}

export interface CorpusCase {
  name: string;
  spec: CorpusSpec;
  html: string;
  /** Ideal markdown (synthetic fixtures) — F1 is measured against this. */
  gold?: string;
  /** Last accepted output (real fixtures) — F1 is measured against this. */
  snapshot?: string;
  snapshotPath: string;
}

export function loadCorpus(): CorpusCase[] {
  const out: CorpusCase[] = [];
  for (const f of readdirSync(CORPUS_DIR).sort()) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    const spec = JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')) as CorpusSpec;
    const htmlPath = join(CORPUS_DIR, `${name}.html`);
    const gzPath = join(CORPUS_DIR, `${name}.html.gz`);
    const html = existsSync(htmlPath)
      ? readFileSync(htmlPath, 'utf8')
      : gunzipSync(readFileSync(gzPath)).toString('utf8');
    const goldPath = join(CORPUS_DIR, `${name}.gold.md`);
    const snapshotPath = join(CORPUS_DIR, `${name}.snap.md`);
    out.push({
      name,
      spec,
      html,
      gold: existsSync(goldPath) ? readFileSync(goldPath, 'utf8') : undefined,
      snapshot: existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8') : undefined,
      snapshotPath,
    });
  }
  return out;
}

export function writeSnapshot(c: CorpusCase, markdown: string): void {
  writeFileSync(c.snapshotPath, `${markdown.trim()}\n`);
}

/** Normalised plain text used for scoring: markdown syntax removed, case-folded, whitespace collapsed. */
export function scoringText(markdown: string): string {
  return markdownToText(markdown).toLowerCase().replace(/\s+/g, ' ').trim();
}

function trigramBag(s: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (let i = 0; i + 3 <= s.length; i++) {
    const g = s.slice(i, i + 3);
    bag.set(g, (bag.get(g) ?? 0) + 1);
  }
  return bag;
}

/**
 * Character-trigram bag F1 between two markdown documents (after `scoringText`). Insensitive to
 * ordering and formatting, sensitive to missing or extra text — a good proxy for "did we get the
 * article and nothing else".
 */
export function charF1(candidate: string, reference: string): { p: number; r: number; f1: number } {
  const a = trigramBag(scoringText(candidate));
  const b = trigramBag(scoringText(reference));
  let overlap = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const n of a.values()) sizeA += n;
  for (const n of b.values()) sizeB += n;
  for (const [g, n] of a) overlap += Math.min(n, b.get(g) ?? 0);
  const p = sizeA ? overlap / sizeA : 0;
  const r = sizeB ? overlap / sizeB : 0;
  const f1 = p + r ? (2 * p * r) / (p + r) : 0;
  return { p, r, f1 };
}

export function countCodeBlocks(md: string): number {
  return (md.match(/^```/gm) ?? []).length >> 1;
}

export function countTableRows(md: string): number {
  return (md.match(/^\|.*\|\s*$/gm) ?? []).filter((l) => !/^\|\s*-{3,}/.test(l)).length;
}
