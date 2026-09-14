import { defineConfig } from 'vitest/config';

// Live tests hit real networks / models. Run with `npm run test:live`.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.live.test.ts', 'packages/*/test/**/*.live.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    // Third-party services (search engines, Wikipedia, arXiv, model downloads) are occasionally
    // slow or return odd results; a failed live test is re-run before it counts as a failure.
    retry: 2,
  },
});
