/**
 * Build-time generator: JSON Schema for the config (from the zod schema) and the price table used
 * by the opt-in cost estimate. Run by `npm run build` (packages/core) — commit the outputs so the
 * raw GitHub URL always serves the current schema.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configJsonSchema } from '../src/config/json-schema.js';
import { DEFAULT_PRICING, PRICING_AS_OF } from '../src/usage/pricing.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');

function writeIfChanged(path: string, content: string): boolean {
  let prev: string | undefined;
  try {
    prev = readFileSync(path, 'utf8');
  } catch {
    /* new file */
  }
  if (prev === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

const schemaPath = join(pkgRoot, 'schema', 'webvector.config.json');
const schemaChanged = writeIfChanged(
  schemaPath,
  `${JSON.stringify(configJsonSchema(), null, 2)}\n`,
);

const pricingPath = join(repoRoot, 'docs', 'pricing.json');
const pricing = {
  $comment: `Approximate public list prices as of ${PRICING_AS_OF} used by the opt-in cost ESTIMATE (telemetry.pricing). USD per 1M input tokens (embed) / per 1 000 calls (search, rerank). Not a bill — verify with your provider. Override any entry via telemetry.pricing: { embed: {...}, search: {...}, rerank: {...} }. Generated from packages/core/src/usage/pricing.ts by npm run build.`,
  asOf: PRICING_AS_OF,
  ...DEFAULT_PRICING,
};
const pricingChanged = writeIfChanged(pricingPath, `${JSON.stringify(pricing, null, 2)}\n`);

console.log(
  `generate: schema ${schemaChanged ? 'updated' : 'unchanged'} (${schemaPath}), pricing ${pricingChanged ? 'updated' : 'unchanged'} (${pricingPath})`,
);
