# webvector

**Web research for AI agents in one call: search → read the full pages → rank → cited passages.**
Zero config, no API keys, no model download (~12 MB). Upgrades to hybrid vector ranking the moment an embedding runtime or key is present.

```bash
npm i webvector
```

```ts
import { WebVector } from 'webvector';

const wv = new WebVector();                       // DuckDuckGo + BM25 (+ local/hosted embeddings when available)
const res = await wv.research('what is reciprocal rank fusion', {
  relatedQueries: ['RRF k constant'],             // sub-questions: every aspect gets covered
  topK: 8,
});
console.log(res.markdown);                        // "[1] Title — url" + quoted passages + Sources
console.log(res.evidence?.level);                 // 'strong' | 'weak' | 'none', + suggestedQueries
```

## What you can do with it

| Case | Code |
|---|---|
| Research a question and get cited passages | `wv.research(q, { topK, maxPages, freshness: 'week', domainsAllow: ['docs.python.org'] })` |
| Cover several sub-questions in one call | `wv.research(q, { relatedQueries: ['…', '…'] })` → `res.coverage` per sub-question |
| Know whether the evidence is enough (no LLM) | `res.evidence` → `{ level, distinctDomains, suggestedQueries }`; `{ autoRetry: 1 }` searches once more when weak |
| Fit a token budget | `wv.research(q, { maxOutputTokens: 3000 })` — packs by score/token, keeps one passage per source, footer names what was omitted |
| Best sentence per passage / evidence cards | `output.passageMode: 'highlight'`, `output.evidenceCards: true`, `output.deepLinks: true` (`url#:~:text=…`) |
| Read one page (or only its relevant part) | `wv.fetch(url)` · `wv.fetch(url, { selector: 'main', includeLinks: true })` · `wv.fetchAndRetrieve(url, query)` |
| Verify an answer's citations | `wv.verifyCitations(answer, { sessionId })` → verbatim / paraphrase / unsupported per sentence, numbers not in source |
| Reuse pages across calls | `store: { mode: 'session' }` + `sessionId`; persistent: `store: { provider: 'sqlite' }` |
| Control caching per call | `{ maxAgeMs: 0 }` (fresh), `{ cacheMode: 'readOnly' }` (offline) — SQLite page + embedding cache is on by default |
| Explain a ranking | `wv.research(q, { explain: true })` → `passage.explain` (BM25/vector ranks, fused score, lists) |
| Give it to an LLM | `webvector/anthropic`, `webvector/openai`, `webvector/ai-sdk`, `webvector/langchain` adapters — tool definitions + runners (Anthropic `search_result` citation blocks supported) |
| Swap providers | `search: { provider: 'brave' }`, `embeddings: { provider: 'openai' }`, `retrieval: { rerank: 'cohere' }` — 11 search / 9 embedding / 4 store / 5 reranker options, or `customSearchProvider(...)` in one function |

## Two tiers, one knob

`embeddings.provider` defaults to `auto`: local Transformers.js model if `@huggingface/transformers` is installed → else the first hosted provider with a key in the environment (`OPENAI_API_KEY`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`, `COHERE_API_KEY`, `MISTRAL_API_KEY`, `JINA_API_KEY`) → else `none` (BM25F + proximity + query expansion over the fetched pages). Lexical is a supported mode, not a fallback.

## Under the hood (why results are good)

BM25F fields (title/heading/body) with proximity and identifier-aware tokens · relative-score fusion with vectors · per-source and per-domain diversity · adjacent-chunk merge · xQuAD aspect coverage · source-authority priors · markdown-first content negotiation, fast paths (arXiv HTML, GitHub, Hacker News, Stack Exchange, Google Docs), extractor ensemble with a recall guard, JS-shell detection · robots.txt + Content-Signal, SSRF guard, bot-wall detection, size/time caps · every ranking change gated on an offline eval.

Subpath exports: `webvector/search`, `webvector/embeddings`, `webvector/stores`, `webvector/rerankers`, `webvector/retrieval`, `webvector/ingest`, `webvector/config`, `webvector/ai-sdk`, `webvector/anthropic`, `webvector/openai`, `webvector/langchain`, `webvector/testing`.

Docs: [README](https://github.com/rthomas24/web-vector#readme) · [Full guide](https://github.com/rthomas24/web-vector/blob/main/docs/GUIDE.md) · [Configuration](https://github.com/rthomas24/web-vector/blob/main/docs/CONFIGURATION.md) · [Providers](https://github.com/rthomas24/web-vector/blob/main/docs/PROVIDERS.md). MCP server: [`webvector-mcp`](https://www.npmjs.com/package/webvector-mcp) · CLI: [`webvector-cli`](https://www.npmjs.com/package/webvector-cli). Node ≥ 22.12, MIT.
