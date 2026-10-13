import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env.CI);
const channel = process.env.PLAYWRIGHT_CHANNEL;

/**
 * Story tests (07 M3 AC 1–2): axe on every story in the default and two school themes, and visual
 * regression at 5 widths. Requires `pnpm --filter @studyhub/ui build-storybook` first.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide' } },
  use: { baseURL: 'http://127.0.0.1:6007', trace: 'retain-on-failure' },
  projects: [
    {
      name: channel ? `chromium-${channel}` : 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
    },
  ],
  webServer: {
    command: 'node scripts/serve-static.mjs storybook-static 6007',
    url: 'http://127.0.0.1:6007/index.json',
    reuseExistingServer: !isCI,
    timeout: 30_000,
  },
});
