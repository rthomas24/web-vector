# Examples

Each folder is a tiny runnable script. From the repo root: `npm run build`, then e.g. `npx tsx examples/library/basic.ts`.
Provider keys are read from the environment; every example works zero-config except where noted.

| Example | Shows |
|---|---|
| `library/basic.ts` | `new WebVector().research()`, markdown + structured output, events |
| `library/session-and-providers.ts` | session mode across calls, custom providers, config file, LLM hook |
| `ai-sdk/agent.ts` | Vercel AI SDK 7 `generateText` + `webVectorTools` (needs `ai` + a model provider key) |
| `anthropic/tool-loop.ts` | Anthropic Messages API tool loop with `anthropicTools`/`runAnthropicTool` (needs `@anthropic-ai/sdk`) |
| `openai/responses.ts` | OpenAI Responses API function tools with strict schemas (needs `openai`) |
| `langchain/agent.ts` | LangChain.js `createAgent` with `langchainTools` (needs `langchain`) |
| `mcp-http/server.ts` | Programmatic MCP server over Streamable HTTP with a shared WebVector instance |
