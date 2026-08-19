# webvector-cli

```bash
npm i -g webvector-cli
webvector search "what changed in the MCP spec in 2026?" --stats
webvector search "…" -k 8 -p 12 --provider brave --embeddings openai --rerank local --json
webvector fetch https://arxiv.org/pdf/1706.03762 --query "multi-head attention"
webvector serp "reciprocal rank fusion"
webvector doctor --live      # check config, deps, providers, and which tier (lexical/semantic) is active
npm i -g @huggingface/transformers   # optional: semantic tier, fully offline
webvector init               # write webvector.config.yaml + .env.example
webvector config             # print resolved config (secrets redacted)
webvector providers          # list providers and env vars
webvector mcp [--http]       # run the MCP server
```

Part of [WebVector](https://github.com/rthomas24/webvector).
