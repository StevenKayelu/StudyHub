import { defineConfig } from 'vitest/config';

import { swcPlugin } from './vitest.config.mjs';

/**
 * Integration tests run against real PostgreSQL 17 containers (Testcontainers), initialised with the
 * same role script as local development. Files run one at a time: each owns its container.
 */
export default defineConfig({
  plugins: [swcPlugin],
  test: {
    name: 'api-integration',
    environment: 'node',
    include: ['test/integration/**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
