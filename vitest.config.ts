import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: { provider: 'v8', reporter: ['text', 'html'], include: ['packages/*/src/**'] },
  },
});
