import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Run the MCP package's tests against the core *source* (no build step needed).
    alias: [
      {
        find: /^webvector$/,
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
      {
        find: /^webvector\/search$/,
        replacement: fileURLToPath(new URL('./packages/core/src/search/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: { provider: 'v8', reporter: ['text', 'html'], include: ['packages/*/src/**'] },
  },
});
