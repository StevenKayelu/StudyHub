import { defineConfig, devices } from '@playwright/test';

/** Built-web CSP checks with a contract-validated API fixture; no database, accounts or worker. */
export default defineConfig({
  testDir: './tests/security',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3300', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node tests/security/api-fixture.mts',
      url: 'http://127.0.0.1:4400/healthz',
      reuseExistingServer: false,
    },
    ...[3300, 3301].map((port) => ({
      command: 'node scripts/standalone.mjs start',
      // Maintenance deliberately answers 503, which is not a readiness success for Playwright.
      ...(port === 3301 ? { wait: { stdout: /Ready in/ } } : { url: `http://127.0.0.1:${port}` }),
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
        API_INTERNAL_URL: 'http://127.0.0.1:4400',
        MAINTENANCE_MODE: port === 3301 ? 'on' : 'off',
        WEB_CSP_CONNECT_ORIGINS: 'http://127.0.0.1:4401',
      },
      ignoreHTTPSErrors: false,
    })),
  ],
});
