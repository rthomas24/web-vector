// npm i @anthropic-ai/sdk — set ANTHROPIC_API_KEY
import Anthropic from '@anthropic-ai/sdk';
import { WebVector } from 'webvector';
import { anthropicTools, runAnthropicTool } from 'webvector/anthropic';

const client = new Anthropic();
const wv = new WebVector();
const tools = anthropicTools({ include: ['webvector_research', 'webvector_fetch'] });
const messages: any[] = [
  { role: 'user', content: 'Explain reciprocal rank fusion and cite two sources.' },
];

for (let i = 0; i < 6; i++) {
  const res = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1500,
    tools,
    messages,
  });
  const uses = res.content.filter((c: any) => c.type === 'tool_use') as any[];
  if (uses.length === 0) {
    console.log(
      res.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n'),
    );
    break;
  }
  messages.push({ role: 'assistant', content: res.content });
  const results = await Promise.all(uses.map((u) => runAnthropicTool(wv, u.name, u.input)));
  messages.push({
    role: 'user',
    content: uses.map((u, j) => ({
      type: 'tool_result',
      tool_use_id: u.id,
      content: results[j]!.content,
      is_error: results[j]!.isError,
    })),
  });
}
await wv.close();
