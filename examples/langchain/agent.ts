// npm i langchain @langchain/anthropic — set ANTHROPIC_API_KEY
import { ChatAnthropic } from '@langchain/anthropic';
import { createAgent } from 'langchain';
import { WebVector } from 'webvector';
import { langchainTools } from 'webvector/langchain';

const wv = new WebVector();
const agent = createAgent({
  model: new ChatAnthropic({ model: 'claude-sonnet-5' }),
  tools: await langchainTools(wv),
});
const out = await agent.invoke({
  messages: [{ role: 'user', content: 'Summarise how RRF works, with sources.' }],
});
console.log(out.messages.at(-1)?.content);
await wv.close();
