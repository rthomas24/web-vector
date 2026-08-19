/**
 * WebVector golden-set retrieval eval.
 *
 *   npm run eval                      # replay recorded fixtures (offline, deterministic)
 *   npm run eval -- --update-baseline # accept current numbers as the new baseline
 *   npm run eval -- --semantic        # use local embeddings (needs @huggingface/transformers)
 *   npm run eval -- --case rrf        # only cases whose id contains "rrf"
 *   npm run eval -- --json out.json   # also write per-case results
 *   WEBVECTOR_HTTP_FIXTURES=auto npm run eval   # record fixtures for new cases
 *
 * Each case in eval/cases/*.json supplies the query, the candidate URLs (what a search engine would
 * have returned) and ground truth: relevant URLs and phrases that a good top-k must surface. The
 * eval measures fetch → parse → chunk → rank, not the search engine.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  customSearchProvider,
  type ResearchResult,
  WebVector,
} from '../packages/core/src/index.js';
import { approxTokens } from '../packages/core/src/ingest/chunker.js';
import { recordingFetch } from '../packages/core/src/testing/recording-fetch.js';

const here = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(here, 'cases');
const FIXTURES_DIR = join(here, 'fixtures', 'http');
const BASELINE = join(here, 'baseline.json');

interface EvalCase {
  id: string;
  query: string;
  relatedQueries?: string[];
  /** Candidate pages, as a search engine would return them (order = SERP rank). */
  urls: string[];
  relevant: { urls?: string[]; phrases?: string[] };
  topK?: number;
  notes?: string;
}

interface CaseMetrics {
  /** 1 if any of the top-k passages contains an expected phrase. */
  phraseHit: number;
  /** Reciprocal rank of the first phrase-bearing passage (0 if none). */
  phraseMrr: number;
  /** Fraction of relevant URLs represented among the top-k passages. */
  urlRecall: number;
  /** Fraction of top-k passages that are relevant (phrase match or from a relevant URL). */
  precision: number;
  /** Distinct registrable-ish domains among returned passages. */
  distinctDomains: number;
  passages: number;
  tokens: number;
  latencyMs: number;
  /** Phrases that could not be found in any fetched page — ground truth to fix. */
  invalidPhrases: string[];
  failures: number;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const domainOf = (u: string) => {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '');
    const parts = h.split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : h;
  } catch {
    return u;
  }
};

function loadCases(filter?: string): EvalCase[] {
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')) as EvalCase)
    .filter((c) => !filter || c.id.includes(filter));
}

/** Text of every recorded fixture whose URL is in the case (for ground-truth validation). */
function fixtureText(urls: string[]): string {
  const files = readdirSync(FIXTURES_DIR);
  let out = '';
  for (const f of files) {
    const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as {
      url: string;
      body: string;
      bodyEncoding: string;
    };
    if (!urls.some((u) => fx.url === u || fx.url.startsWith(u))) continue;
    if (fx.bodyEncoding === 'base64') continue;
    const raw =
      fx.bodyEncoding === 'gzip-base64'
        ? gunzipSync(Buffer.from(fx.body, 'base64')).toString('utf8')
        : fx.body;
    out += ` ${raw
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")}`;
  }
  return norm(out);
}

function score(c: EvalCase, res: ResearchResult, latencyMs: number): CaseMetrics {
  const phrases = (c.relevant.phrases ?? []).map(norm);
  const relUrls = new Set((c.relevant.urls ?? []).map((u) => u.replace(/\/$/, '')));
  const isRelUrl = (u: string) => relUrls.has(u.replace(/\/$/, ''));
  let firstPhraseRank = 0;
  let relevantCount = 0;
  const seenRelUrls = new Set<string>();
  const domains = new Set<string>();
  res.passages.forEach((p, i) => {
    const t = norm(p.text);
    const phraseMatch = phrases.some((ph) => t.includes(ph));
    if (phraseMatch && !firstPhraseRank) firstPhraseRank = i + 1;
    if (phraseMatch || isRelUrl(p.url)) relevantCount++;
    if (isRelUrl(p.url)) seenRelUrls.add(p.url.replace(/\/$/, ''));
    domains.add(domainOf(p.url));
  });
  const haystack = fixtureText(c.urls);
  const invalidPhrases = phrases.filter((ph) => !haystack.includes(ph));
  return {
    phraseHit: phrases.length ? (firstPhraseRank ? 1 : 0) : 1,
    phraseMrr: firstPhraseRank ? 1 / firstPhraseRank : 0,
    urlRecall: relUrls.size ? seenRelUrls.size / relUrls.size : 1,
    precision: res.passages.length ? relevantCount / res.passages.length : 0,
    distinctDomains: domains.size,
    passages: res.passages.length,
    tokens: approxTokens(res.markdown ?? res.passages.map((p) => p.text).join('\n')),
    latencyMs,
    invalidPhrases,
    failures: res.failures.length,
  };
}

async function main() {
  const semantic = flag('--semantic');
  const cases = loadCases(opt('--case'));
  if (cases.length === 0) {
    console.error('No eval cases found.');
    process.exit(2);
  }
  const fetchImpl = recordingFetch({
    dir: FIXTURES_DIR,
    compress: true,
    // Keep fixtures small: scripts, styles and inline SVG never affect content extraction here.
    transformBody: (body, fx) =>
      /text\/html/i.test(fx.headers['content-type'] ?? '')
        ? body
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
        : body,
  });
  const results: Record<string, CaseMetrics> = {};

  for (const c of cases) {
    const provider = customSearchProvider('eval', async () =>
      c.urls.map((url, i) => ({ url, title: url, rank: i + 1 })),
    );
    const wv = await WebVector.create({
      search: { provider: 'eval', instance: provider, fallbackProviders: [] },
      embeddings: { provider: semantic ? 'local' : 'none' },
      retrieval: { topK: c.topK ?? 8 },
      ingestion: { maxPages: Math.max(c.urls.length, 1), cache: { enabled: false } },
      output: { markdown: true },
      logging: { level: 'silent' },
      fetch: fetchImpl,
    });
    const t0 = Date.now();
    let res: ResearchResult;
    try {
      res = await wv.research(c.query, {
        relatedQueries: c.relatedQueries,
        maxPages: c.urls.length,
        topK: c.topK ?? 8,
      });
    } finally {
      await wv.close();
    }
    results[c.id] = score(c, res, Date.now() - t0);
    const m = results[c.id];
    const flagTxt = m.invalidPhrases.length
      ? `  ⚠ phrase not on page: ${m.invalidPhrases.join(' | ')}`
      : '';
    console.log(
      `${m.phraseHit ? '✔' : '✘'} ${c.id.padEnd(28)} hit=${m.phraseHit} mrr=${m.phraseMrr.toFixed(2)} urlR=${m.urlRecall.toFixed(2)} prec=${m.precision.toFixed(2)} dom=${m.distinctDomains} n=${m.passages} tok=${m.tokens} fail=${m.failures} ${m.latencyMs}ms${flagTxt}`,
    );
  }

  const ids = Object.keys(results);
  const avg = (k: keyof CaseMetrics) =>
    ids.reduce((a, id) => a + (results[id]![k] as number), 0) / ids.length;
  const summary = {
    cases: ids.length,
    phraseHit: avg('phraseHit'),
    phraseMrr: avg('phraseMrr'),
    urlRecall: avg('urlRecall'),
    precision: avg('precision'),
    distinctDomains: avg('distinctDomains'),
    tokens: avg('tokens'),
    latencyMs: avg('latencyMs'),
  };
  console.log('\nSummary (mean over cases):');
  for (const [k, v] of Object.entries(summary))
    console.log(`  ${k.padEnd(16)} ${typeof v === 'number' ? v.toFixed(3) : v}`);
  console.log(
    `  fixtures: ${fetchImpl.stats.hits} hits, ${fetchImpl.stats.recorded} recorded, mode=${fetchImpl.stats.mode}`,
  );

  const invalid = ids.filter((id) => results[id]!.invalidPhrases.length);
  if (invalid.length)
    console.log(
      `\n⚠ ${invalid.length} case(s) have phrases not found on any fetched page — fix the ground truth.`,
    );

  const jsonOut = opt('--json');
  if (jsonOut)
    writeFileSync(resolve(jsonOut), `${JSON.stringify({ summary, results }, null, 2)}\n`);

  const tier = semantic ? 'semantic' : 'lexical';
  let baseline: Record<string, { summary: typeof summary; results: Record<string, CaseMetrics> }> =
    {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch {
    /* no baseline yet */
  }
  const prev = baseline[tier];
  if (flag('--update-baseline')) {
    baseline[tier] = { summary, results };
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\nBaseline (${tier}) updated.`);
    return;
  }
  if (!prev) {
    console.log(`\nNo ${tier} baseline yet — run with --update-baseline to create one.`);
    return;
  }
  console.log(`\nΔ vs baseline (${tier}):`);
  let regressed = false;
  for (const k of ['phraseHit', 'phraseMrr', 'urlRecall', 'precision', 'tokens'] as const) {
    const d = (summary[k] as number) - (prev.summary[k] as number);
    const sign = d > 0 ? '+' : '';
    console.log(`  ${k.padEnd(16)} ${sign}${d.toFixed(3)}`);
    if ((k === 'phraseHit' || k === 'urlRecall' || k === 'phraseMrr') && d < -0.02)
      regressed = true;
  }
  for (const id of ids) {
    const p = prev.results[id];
    if (!p) continue;
    if (p.phraseHit && !results[id]!.phraseHit)
      console.log(`  ✘ regression: ${id} lost its phrase hit`);
    if (!p.phraseHit && results[id]!.phraseHit) console.log(`  ✔ improvement: ${id} now hits`);
  }
  if (regressed) {
    console.error('\nRegression beyond tolerance.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
