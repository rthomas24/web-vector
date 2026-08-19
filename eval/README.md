# Retrieval eval

A small golden set that measures WebVector's fetch → parse → chunk → rank pipeline offline, so
ranking changes are provable instead of guessed. It runs in CI on every push.

```bash
npm run eval                        # replay recorded fixtures (deterministic, no network)
npm run eval -- --case rrf          # subset by id substring
npm run eval -- --update-baseline   # accept the current numbers (do this deliberately, in the same PR)
npm run eval -- --semantic          # local embeddings tier (needs @huggingface/transformers)
WEBVECTOR_HTTP_FIXTURES=auto npm run eval   # record fixtures for newly added cases
```

## How it works

- `cases/*.json` — one case per file: `query`, the candidate `urls` a search engine would have
  returned (in SERP order), and ground truth `relevant.urls` / `relevant.phrases`. Optional
  `relatedQueries`, `topK`, `notes`. Distractor URLs are deliberately topically adjacent.
- The search stage is replaced by a provider that returns the case's URLs, so the numbers measure
  our logic, not DuckDuckGo.
- HTTP goes through `recordingFetch()` from `webvector/testing`; fixtures live in `fixtures/http/`
  (one JSON per request, gzip-compressed, scripts/styles stripped, no cookies or credentials).
- Every phrase is checked against the recorded pages; a phrase that is not on any page is reported
  as invalid ground truth rather than silently counted as a miss.
- `baseline.json` stores the last accepted numbers per tier. The run exits non-zero if mean
  `phraseHit`, `phraseMrr` or `urlRecall` drops by more than 0.02.

## Metrics (mean over cases)

| metric | meaning |
|---|---|
| `phraseHit` | 1 if any top-k passage contains an expected phrase |
| `phraseMrr` | reciprocal rank of the first phrase-bearing passage |
| `urlRecall` | share of relevant URLs represented in the top-k |
| `precision` | share of top-k passages that are relevant (phrase or relevant URL) |
| `distinctDomains` | source diversity of the top-k |
| `tokens` | approximate tokens of the rendered markdown |

## Adding a case

1. Pick a query with an unambiguous, stable answer page and 3–6 adjacent distractors.
2. Choose phrases that literally appear in the page *text* (not in MathML/alt text).
3. `WEBVECTOR_HTTP_FIXTURES=auto npm run eval -- --case <id>` to record, check for ⚠ warnings.
4. Commit the case, its fixtures and (if intended) the updated baseline together.

Fixture pages are reproduced for testing under their respective licences (Wikipedia CC BY-SA,
MDN CC BY-SA, Python/PEPs PSF, IETF RFCs, Node.js MIT, sqlite.org public domain, Elastic docs).
