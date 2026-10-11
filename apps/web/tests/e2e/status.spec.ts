import { expect, test } from '@playwright/test';

test('status page reports the API and the database as ok', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'StudyHub — system status' })).toBeVisible();
  await expect(page.getByTestId('api-status')).toHaveText('ok');
  await expect(page.getByTestId('database-status')).toHaveText('ok');
  await expect(page.getByTestId('api-version')).not.toHaveText('unknown');
});

test('the /api rewrite reaches the API and the request id is echoed', async ({ request }) => {
  const response = await request.get('/api/healthz', { headers: { 'X-Request-Id': 'e2e-request-0001' } });
  expect(response.ok()).toBe(true);
  expect(response.headers()['x-request-id']).toBe('e2e-request-0001');
  const body = (await response.json()) as { status: string; service: string };
  expect(body).toMatchObject({ status: 'ok', service: 'studyhub-api' });
});
