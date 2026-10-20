import { defineConfig } from 'vitest/config';

import { swcPlugin } from './vitest.config.mjs';

/** Opt-in timing checks: do not mix with browser builds or other performance measurements. */
export default defineConfig({
  plugins: [swcPlugin],
  test: {
    environment: 'node',
    include: ['test/load/**/*.test.ts'],
    fileParallelism: false,
    hookTimeout: 300_000,
    testTimeout: 120_000,
  },
});
