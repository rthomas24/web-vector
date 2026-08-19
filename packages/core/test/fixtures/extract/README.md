# Extraction regression corpus

Offline HTML fixtures across page types, checked by `packages/core/test/extract.test.ts` on every
`npm test`. The field's lesson (WCXB 2026, Trafilatura's evaluation) is that extractors regress
silently across page types: an article-tuned change quietly deletes forum answers or docs tables.
This corpus is the safety net for every parser change.

## Layout

| file | meaning |
|---|---|
| `<name>.html` | synthetic page written for this corpus (licence-clean; all prose is original) |
| `<name>.html.gz` | real recorded page copied from `eval/fixtures/http` (`<script>`/`<style>`/`<svg>` already stripped there) |
| `<name>.gold.md` | ideal markdown for a synthetic page = its authored content region converted with mdream. F1 is measured against this. |
| `<name>.snap.md` | last accepted extractor output for a real page. F1 is measured against this — a regression detector, not a truth. |
| `<name>.json` | expectations: `failure`, `minF1`, `mustContain`, `mustNotContain`, `meta`, `minChars`, `minCodeBlocks`, `minTableRows`, `contentType`, `expectFail` |

`expectFail: "<work item>"` marks a known gap; the test runs it with `it.fails` and fails once the
fixture starts passing — remove the flag then.

## Metric

`charF1` = F1 over the bag of character trigrams of the extracted text vs the reference text (both
markdown-stripped, case-folded, whitespace-collapsed). It ignores ordering and formatting and
penalises both missing content (recall) and leaked boilerplate (precision).

## Regenerating

```sh
npx tsx packages/core/test/fixtures/extract/generate.mts          # synthetic pages + gold + specs
npx tsx packages/core/test/fixtures/extract/generate.mts --real   # copy real pages from eval/fixtures/http
UPDATE_EXTRACT_SNAPSHOTS=1 npx vitest run packages/core/test/extract.test.ts   # accept new real-page output
```

Edit fixtures in `generate.mts`, not the generated files.
