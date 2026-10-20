import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';

import { cspOrigins, webContentSecurityPolicy } from '../../src/lib/security-headers';
import { proxy } from '../../src/proxy';

const school = 'http://security.localhost:3300';

test('configuration rejects wildcard, insecure external and directive-injection sources', () => {
  for (const value of [
    'https://*.example.test',
    'http://external.test',
    'https://cdn.test; script-src *',
    'https://user:pass@cdn.test',
    'https://cdn.test/path',
    'data:',
    'https://cdn.test/?x=1',
  ])
    expect(() => cspOrigins(value)).toThrow();
  expect(cspOrigins('https://cdn.test,https://cdn.test,http://127.0.0.1:4401')).toEqual([
    'https://cdn.test',
    'http://127.0.0.1:4401',
  ]);
  expect(webContentSecurityPolicy('test-nonce', false, false)).not.toContain('unsafe-eval');
  expect(webContentSecurityPolicy('test-nonce', false, false)).toContain('upgrade-insecure-requests');
  expect(webContentSecurityPolicy('test-nonce', true, true)).toContain('unsafe-eval');
});

test('malformed hosts get security headers on the proxy early response', () => {
  const response = proxy(new NextRequest('http://localhost/', { headers: { host: 'bad/host' } }));
  expect(response.status).toBe(400);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
});

test('nonces are fresh and untrusted incoming nonce/policy headers cannot replace them', async ({
  request,
}) => {
  const nonces = [];
  for (let i = 0; i < 2; i += 1) {
    const response = await request.get('/', {
      headers: { 'x-nonce': 'attacker', 'content-security-policy': "script-src 'unsafe-inline'" },
    });
    expect(response.ok()).toBe(true);
    const headers = response.headers();
    const policy = headers['content-security-policy']!;
    expect(policy).not.toContain('attacker');
    expect(policy).not.toContain('unsafe-eval');
    const nonce = /'nonce-([^']+)'/.exec(policy)![1]!;
    expect(Buffer.from(nonce, 'base64').length).toBe(32);
    nonces.push(nonce);
    expect(await response.text()).toContain(`nonce="${nonce}"`);
    expect(headers['cache-control']).toContain('no-store');
    expect(headers['strict-transport-security']).toBe('max-age=31536000');
  }
  expect(nonces[0]).not.toBe(nonces[1]);
});

test('the production page executes framework scripts but blocks injected inline script and frames', async ({
  page,
}) => {
  // Inject as parser HTML, not from DevTools' trusted evaluation world.
  await page.route('http://127.0.0.1:3300/', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      '</body>',
      '<script>window.__injected = true</script><iframe src="/"></iframe></body>',
    );
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => {
    (window as unknown as { cspViolations: string[] }).cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { cspViolations: string[] }).cspViolations.push(event.effectiveDirective);
    });
  });
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("frame-src 'none'");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations.length))
    .toBeGreaterThanOrEqual(2);
  const result = await page.evaluate(() => {
    return {
      injected: '__injected' in window,
      violations: (window as unknown as { cspViolations: string[] }).cspViolations,
      scripts: [...document.scripts].map((entry) => entry.nonce),
    };
  });
  expect(result.injected).toBe(false);
  expect(result.violations).toContain('script-src-elem');
  expect(result.violations).toContain('frame-src');
  expect(result.scripts.filter(Boolean).length).toBeGreaterThan(2);
});

test('school and console forms hydrate, submit by fetch and retain their theme', async ({ page }) => {
  // Route browser API calls to the fixture too: production rewrites use the build-time API URL,
  // which may point at an existing developer server. Never submit to that server in this suite.
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/console\//, '/console/');
    await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:4400${path}` }) });
  });
  for (const [origin, endpoint, button] of [
    [school, '/api/v1/auth/sign-in', 'Sign in'],
    ['http://console.localhost:3300', '/api/console/auth/sign-in', 'Continue'],
  ] as const) {
    const cspErrors: string[] = [];
    const listener = (message: import('@playwright/test').ConsoleMessage) => {
      if (message.text().includes('Content Security Policy')) cspErrors.push(message.text());
    };
    page.on('console', listener);
    await page.goto(`${origin}/sign-in`);
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Email', { exact: true }).fill('fixture@example.test');
    await page.getByLabel('Password', { exact: true }).fill('fixture-long-password');
    const submission = page.waitForRequest(
      (request) => request.url().endsWith(endpoint) && request.method() === 'POST',
    );
    await page.getByRole('button', { name: button, exact: true }).click();
    expect((await submission).resourceType()).toBe('fetch');
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--sh-color-accent').trim(),
      ),
    ).not.toBe('');
    expect(cspErrors).toEqual([]);
    page.off('console', listener);
  }
});

test('client navigation keeps the document nonce and hydrated forms usable', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) errors.push(message.text());
  });
  await page.goto(`${school}/sign-in`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    (window as unknown as { navigationMarker: boolean }).navigationMarker = true;
  });
  await page.locator('a[href="/forgot-password"]').click();
  await expect(page).toHaveURL(`${school}/forgot-password`);
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { navigationMarker: boolean }).navigationMarker),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('configured storage origins can upload and unlisted connections are refused', async ({ page }) => {
  await page.goto('/');
  expect(
    await page.evaluate(async () =>
      (await fetch('http://127.0.0.1:4401/upload', { method: 'PUT', body: 'fixture' })).text(),
    ),
  ).toBe('fixture-upload-ok');
  const blocked = await page.evaluate(async () => {
    try {
      await fetch('http://127.0.0.1:4402/not-allowed');
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);
});

test('internal-route errors, unknown schools, maintenance and static assets carry headers', async ({
  request,
}) => {
  for (const [url, status] of [
    ['/_tenant/other', 404],
    ['/sign-in', 404],
    ['http://127.0.0.1:3301/', 503],
  ]) {
    const response = await request.get(String(url), {
      headers: url === '/sign-in' ? { host: 'unknown.localhost:3300' } : {},
    });
    expect(response.status(), `${url}: ${(await response.text()).slice(0, 700)}`).toBe(status);
    expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    if (status === 503) expect(response.headers()['retry-after']).toBe('600');
  }
  const response = await request.get('/');
  const script = /src="([^"]+\.js[^"]*)"/.exec(await response.text())![1]!;
  expect((await request.get(script)).headers()['x-content-type-options']).toBe('nosniff');
});
