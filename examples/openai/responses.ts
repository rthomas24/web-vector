// npm i openai — set OPENAI_API_KEY
import OpenAI from 'openai';
import { WebVector } from 'webvector';
import { openaiTools, runOpenAITool } from 'webvector/openai';

const client = new OpenAI();
const wv = new WebVector({ embeddings: { provider: 'openai' } });
const tools = openaiTools({ include: ['web_research'] }) as any;
let input: any[] = [
  { role: 'user', content: 'What is Brave Search API pricing in 2026? Cite sources.' },
];

for (let i = 0; i < 6; i++) {
  const res = await client.responses.create({ model: 'gpt-5', input, tools });
  const calls = res.output.filter((o: any) => o.type === 'function_call') as any[];
  if (calls.length === 0) {
    console.log(res.output_text);
    break;
  }
  input = [...input, ...res.output];
  for (const c of calls) {
    const r = await runOpenAITool(wv, c.name, c.arguments);
    input.push({ type: 'function_call_output', call_id: c.call_id, output: r.content });
  }
}
await wv.close();
