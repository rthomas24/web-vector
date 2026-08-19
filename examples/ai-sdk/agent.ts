// npm i ai @ai-sdk/anthropic   (or any provider) — set ANTHROPIC_API_KEY
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, isStepCount } from 'ai';
import { WebVector } from 'webvector';
import { llmFromAiSdk, webVectorTools } from 'webvector/ai-sdk';

// import { fromAiSdkEmbeddingModel } from 'webvector/ai-sdk';

const model = anthropic('claude-sonnet-5');
const wv = new WebVector({
  // Optional: use any AI SDK embedding model instead of the built-in adapters:
  // embeddings: { instance: fromAiSdkEmbeddingModel(openai.embedding('text-embedding-3-small')) },
  retrieval: { llm: llmFromAiSdk(model) }, // LLM multi-query expansion
});

const { text, steps } = await generateText({
  model,
  instructions:
    'You are a research assistant. Use webvector_research for anything factual and cite sources as [n].',
  tools: await webVectorTools(wv),
  stopWhen: isStepCount(6),
  prompt: 'What changed in the MCP specification revision 2026-07-28 regarding sessions?',
});
console.log(text);
console.log(
  'tool calls:',
  steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
);
await wv.close();
