import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  external: [
    'webvector',
    '@modelcontextprotocol/server',
    '@modelcontextprotocol/node',
    '@huggingface/transformers',
    'zod',
  ],
});
