import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Keep the persistent page/embedding cache and the sqlite store out of the developer's real
// ~/.cache and ~/.local/share while testing (the defaults resolve through XDG_*_HOME).
const xdg = mkdtempSync(join(tmpdir(), 'webvector-test-xdg-'));

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { XDG_CACHE_HOME: join(xdg, 'cache'), XDG_DATA_HOME: join(xdg, 'data') },
    coverage: { provider: 'v8', reporter: ['text', 'html'], include: ['packages/*/src/**'] },
  },
});
