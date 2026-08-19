import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  external: ['webvector', 'webvector-mcp', 'commander', '@huggingface/transformers', 'yaml'],
});
