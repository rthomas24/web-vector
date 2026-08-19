import { WebVector } from 'webvector';

const wv = new WebVector({ logging: { level: 'info' } });
wv.on('stage', (s) => console.error(`  ${s.stage}: ${s.ms}ms`));

const res = await wv.research('what is reciprocal rank fusion and what is k=60', {
  topK: 5,
  maxPages: 8,
});
console.log(res.markdown);
console.log(
  '\nsources:',
  res.sources.map((s) => `${s.status} ${s.url}`),
);
console.log(
  'stats:',
  res.stats.totalMs,
  'ms;',
  res.stats.embed.chunks,
  'chunks;',
  res.failures.length,
  'failures',
);
await wv.close();
