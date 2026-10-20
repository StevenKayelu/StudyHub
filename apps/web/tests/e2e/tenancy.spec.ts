import { expect, test } from '@playwright/test';

import { school } from './helpers';

// Requires the demo schools from `pnpm db:seed` (acme.localhost, beta.localhost).

test('T-ISO-19: each school host renders its own school, with no cross-host cache mixing', async ({
  page,
}) => {
  for (const [host, name] of [
    ['acme.localhost', 'Acme Academy'],
    ['beta.localhost', 'Beta College'],
    ['acme.localhost', 'Acme Academy'],
    ['beta.localhost', 'Beta College'],
  ] as const) {
    await page.goto(school(host));
    await expect(page.getByTestId('tenant-name'), host).toHaveText(name);
  }
});

test('an unknown host gets a generic not-found page that names no school', async ({ page }) => {
  const response = await page.goto(school('nope.localhost'));
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Site not found');
  await expect(page.locator('body')).not.toContainText(/Acme|Beta/);
});

test('the internal /_tenant route cannot be used to render another school', async ({ page }) => {
  const response = await page.goto(school('acme.localhost', '/_tenant/beta.localhost'));
  expect(response?.status()).toBe(404);
  await expect(page.locator('body')).not.toContainText('Beta College');
});

test('the internal /_tenant route cannot be reached from the platform host either', async ({ page }) => {
  const response = await page.goto('/_tenant/beta.localhost'); // baseURL: http://127.0.0.1:3000
  expect(response?.status()).toBe(404);
  await expect(page.locator('body')).not.toContainText('Beta College');
});

test('through the web origin, the API resolves the real host and ignores a spoofed X-Forwarded-Host', async ({
  page,
}) => {
  await page.goto(school('acme.localhost'));
  const body = await page.evaluate(async () => {
    const response = await fetch('/api/v1/tenant', { headers: { 'x-forwarded-host': 'beta.localhost' } });
    return (await response.json()) as { slug: string };
  });
  expect(body.slug).toBe('acme');
});
