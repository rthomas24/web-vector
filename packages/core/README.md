# webvector

Provider-agnostic web research for AI agents: **search → read full pages → embed → hybrid semantic retrieval → cited passages**, in one call.

```ts
import { WebVector } from 'webvector';
const wv = new WebVector();                                       // zero-config: DuckDuckGo + auto embeddings (lexical BM25 until a model runtime/API key exists) + memory
const res = await wv.research('what is reciprocal rank fusion');
console.log(res.markdown);
```

Subpath exports: `webvector/search`, `webvector/embeddings`, `webvector/stores`, `webvector/rerankers`, `webvector/retrieval`, `webvector/ingest`, `webvector/config`, `webvector/ai-sdk`, `webvector/anthropic`, `webvector/openai`, `webvector/langchain`, `webvector/testing`.

`embeddings.provider` defaults to `auto`: local Transformers.js model if the optional peer `@huggingface/transformers` is installed, else the first hosted provider with a key in the environment (`OPENAI_API_KEY`, `VOYAGE_API_KEY`, …), else `none` — lexical BM25 ranking over the fetched pages (~12 MB install, no downloads). Set it explicitly to pin a tier.

Full documentation: https://github.com/rthomas24/web-vector
