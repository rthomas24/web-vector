# webvector-cli

Web research from the terminal: **search → read the full pages → rank → cited passages**. No keys, no model download; upgrades to hybrid vector ranking when `@huggingface/transformers` or an embedding key is present.

```bash
npm i -g webvector-cli          # or: npx -y webvector-cli search "…"
webvector search "what changed in the MCP spec in 2026?"
```

## Cases

```bash
# Research: cited passages, 8 of them, from ≤ 12 pages, last month only
webvector search "node 24 AbortSignal.any semantics" -k 8 -p 12 -f month --stats

# Cover sub-questions in one call (each aspect is guaranteed passages)
webvector search "TCP vs UDP" -r "UDP connectionless" "TCP three-way handshake"

# Only trusted domains; JSON for scripts / agents
webvector search "dataclass frozen" --allow docs.python.org --json > r.json

# Read one page (or only what matters in it)
webvector fetch https://arxiv.org/abs/1706.03762                 # arXiv → full HTML paper via fast path
webvector fetch https://nodejs.org/api/fs.html --query "readFile encoding"

# Verify an answer's [n] citations against the passages you got (no LLM)
webvector verify "RRF sums 1/(k+rank) [1]. It was invented in 2019 [2]." --result r.json

# Why did a passage rank where it did?
webvector search "reciprocal rank fusion k constant" --explain

# Caching: fresh vs offline
webvector search "…" --max-age 0        # ignore cache
webvector search "…" --cache-only       # never touch the network
webvector cache stats | ls | prune --older-than 7d | clear

# Setup & health
webvector init --yes            # webvector.config.yaml (+ .env.example) with editor autocomplete
webvector doctor [--live] [--fix] [--json]   # tier, providers, cache/store paths, local model
webvector providers             # every provider and the env var it reads
webvector serp "query"          # search only
webvector mcp [--http]          # run the MCP server (see webvector-mcp)
```

Providers on the fly: `--provider brave|serper|tavily|exa|searxng …`, `--embeddings openai|local|none`, `--rerank local|cohere|voyage|jina`. Config: `webvector.config.yaml` in the working directory or `WEBVECTOR_*` env vars — see [Configuration](https://github.com/rthomas24/web-vector/blob/main/docs/CONFIGURATION.md).

Part of [WebVector](https://github.com/rthomas24/web-vector) — library [`webvector`](https://www.npmjs.com/package/webvector), MCP server [`webvector-mcp`](https://www.npmjs.com/package/webvector-mcp). Node ≥ 22.12, MIT.
