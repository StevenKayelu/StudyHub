import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env.CI);

/**
 * Browser: Playwright's bundled Chromium by default (CI). Set PLAYWRIGHT_CHANNEL=msedge (or chrome) to use
 * an installed browser instead, e.g. where the bundled browser cannot be downloaded.
 */
const channel = process.env.PLAYWRIGHT_CHANNEL;

/**
 * E2E tests. Require PostgreSQL and Mailpit running, migrated and seeded (`pnpm db:up && pnpm db:migrate &&
 * pnpm db:seed`) and built apps (`pnpm build`). Playwright starts the API, the worker and the web server.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: channel ? `chromium-${channel}` : 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
      testIgnore: /lighthouse\.spec\.ts/,
    },
    {
      // Runs after the functional tests, alone, so CPU contention can't distort its timings.
      name: 'lighthouse',
      testMatch: /lighthouse\.spec\.ts/,
      dependencies: [channel ? `chromium-${channel}` : 'chromium'],
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @studyhub/api start',
      cwd: '../..',
      url: 'http://127.0.0.1:4000/healthz',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      // Sends the emails the identity tests read back from Mailpit (pnpm db:up starts it).
      command: 'pnpm --filter @studyhub/api start:worker',
      cwd: '../..',
      wait: { stdout: /Worker started/ },
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @studyhub/web start',
      cwd: '../..',
      url: 'http://127.0.0.1:3000',
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
});
