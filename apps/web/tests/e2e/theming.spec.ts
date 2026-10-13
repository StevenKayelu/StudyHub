import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DEMO, signIn } from './helpers';

// Requires `pnpm db:seed`: acme (Copperline default), beta (teal, Humanist, "Lecturer"/"Module"),
// gamma (provisioning).
const school = (host: string, path = '/') => `http://${host}:3000${path}`;

const cssVar = (page: Page, name: string) =>
  page.evaluate(
    (variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
    name,
  );

interface Fetched {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * GET a path on a school host, same-origin from a page on that host. (Node's request client can't
 * resolve *.localhost; Chromium resolves it to loopback.)
 */
async function fetchOn(page: Page, host: string, path: string): Promise<Fetched> {
  if (!page.url().startsWith(school(host))) await page.goto(school(host, '/offline'));
  return page.evaluate(async (target) => {
    const response = await fetch(target, { cache: 'no-store' });
    const isText = !(response.headers.get('content-type') ?? '').startsWith('image/png');
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: isText ? await response.text() : '',
    };
  }, path);
}

async function expectNoSeriousAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
    );
  expect(blocking).toEqual([]);
}

test.describe('school theming runtime (M3)', () => {
  test('each school renders with its own accent and font preset; Copperline is the default', async ({
    page,
  }) => {
    await page.goto(school('acme.localhost'));
    expect(await cssVar(page, '--sh-color-accent')).toBe('#a3471c');
    const acmeFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);

    await page.goto(school('beta.localhost'));
    expect(await cssVar(page, '--sh-color-accent')).toBe('#0b7285');
    const betaFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(betaFont).not.toBe(acmeFont);

    // Back to acme: nothing of beta's theme leaks across hosts (UX-15).
    await page.goto(school('acme.localhost'));
    expect(await cssVar(page, '--sh-color-accent')).toBe('#a3471c');
    await expect(page.locator('body')).not.toContainText('Beta');
  });

  test('dark mode uses the compiled dark accent', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(school('beta.localhost'));
    await expect.poll(() => cssVar(page, '--sh-color-bg-canvas')).toBe('#111416');
    const accent = await cssVar(page, '--sh-color-accent');
    expect(accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(accent).not.toBe('#0b7285');
    await context.close();
  });

  test('terminology substitution: each school sees its own words', async ({ page }) => {
    await signIn(page, 'beta.localhost', DEMO.betaOwner, '/admin');
    await expect(page.getByText('Lecturer applications')).toBeVisible();
    await expect(page.getByText('Module reviews')).toBeVisible();
    await signIn(page, 'acme.localhost', DEMO.acmeOwner, '/admin');
    await expect(page.getByText('Tutor applications')).toBeVisible();
    await expect(page.getByText('Course reviews')).toBeVisible();
  });

  test('the theme CSS route is immutable, bound to its school and to the current version', async ({
    page,
  }) => {
    const beta = JSON.parse((await fetchOn(page, 'beta.localhost', '/api/v1/tenant')).body);
    const acme = JSON.parse((await fetchOn(page, 'acme.localhost', '/api/v1/tenant')).body);
    const path = `/theme/${beta.id}/${beta.branding.version}.css`;

    const ok = await fetchOn(page, 'beta.localhost', path);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('text/css');
    expect(ok.headers['cache-control']).toContain('immutable');
    expect(ok.body).toContain('#0b7285');

    // Another school's theme can't be fetched through this host, and stale versions aren't served.
    expect((await fetchOn(page, 'acme.localhost', path)).status).toBe(404);
    expect((await fetchOn(page, 'beta.localhost', `/theme/${acme.id}/1.css`)).status).toBe(404);
    const next = `/theme/${beta.id}/${beta.branding.version + 1}.css`;
    expect((await fetchOn(page, 'beta.localhost', next)).status).toBe(404);
  });

  test('manifest, icons and OG image carry the school brand', async ({ page }) => {
    const manifest = JSON.parse((await fetchOn(page, 'beta.localhost', '/manifest.webmanifest')).body);
    expect(manifest).toMatchObject({ name: 'Beta College', theme_color: '#0b7285', start_url: '/learn' });

    const mark = await fetchOn(page, 'beta.localhost', '/mark.svg');
    expect(mark.headers['content-type']).toContain('image/svg+xml');
    expect(mark.body).toContain('#0b7285');

    for (const path of ['/icon/192', '/icon/512', '/og.png']) {
      const image = await fetchOn(page, 'beta.localhost', path);
      expect(image.status, path).toBe(200);
      expect(image.headers['content-type'], path).toBe('image/png');
    }
    expect((await fetchOn(page, 'beta.localhost', '/icon/64')).status).toBe(404);

    const acmeManifest = JSON.parse((await fetchOn(page, 'acme.localhost', '/manifest.webmanifest')).body);
    expect(acmeManifest).toMatchObject({ name: 'Acme Academy', theme_color: '#a3471c' });
  });

  test('pages declare the request locale, the manifest and the favicon', async ({ page }) => {
    await page.goto(school('beta.localhost'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/mark.svg');
    await expect(page).toHaveTitle('Beta College');
  });
});

test.describe('shells and system screens (M3)', () => {
  // Each space visited by someone allowed in (M4 guards the signed-in spaces).
  const shells = [
    { path: '/', heading: 'Acme Academy', as: null },
    { path: '/learn', heading: 'My learning', as: DEMO.learner },
    { path: '/studio', heading: 'Courses', as: DEMO.acmeTutor },
    { path: '/admin', heading: 'Overview', as: DEMO.acmeOwner },
  ] as const;

  for (const host of ['acme.localhost', 'beta.localhost']) {
    for (const { path, as } of shells) {
      test(`${host}${path} has no serious axe violations`, async ({ page }) => {
        // Beta has no instructor: its studio shows the permission page (S-X05), which is checked too.
        const account =
          as === null ? null : host === 'beta.localhost' && as !== DEMO.learner ? DEMO.betaOwner : as;
        if (account !== null) await signIn(page, host, account, path);
        else await page.goto(school(host, path));
        await expect(page.getByRole('main')).toBeVisible();
        await expectNoSeriousAxeViolations(page);
      });
    }
  }

  test('each shell renders its landmark structure and one h1', async ({ page }) => {
    for (const { path, heading, as } of shells) {
      if (as !== null) await signIn(page, 'acme.localhost', as, path);
      else await page.goto(school('acme.localhost', path));
      await expect(page.getByRole('heading', { level: 1 }), path).toHaveText(heading);
      await expect(page.getByRole('link', { name: 'Skip to content' }), path).toBeAttached();
      await expect(page.getByRole('navigation').first(), path).toBeAttached();
    }
  });

  test('the learner shell switches to a bottom bar on compact screens', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, 'acme.localhost', DEMO.learner);
    const bottomBar = page.locator('nav.fixed');
    await expect(bottomBar).toBeVisible();
    await expect(bottomBar.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('S-X01: an unknown path on a school host gets that school’s not-found page with 404', async ({
    page,
  }) => {
    const response = await page.goto(school('beta.localhost', '/no-such-page'));
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("We can't find that page");
    expect(await cssVar(page, '--sh-color-accent')).toBe('#0b7285');
    await expectNoSeriousAxeViolations(page);
  });

  test('S-X06: an unknown host gets the neutral site-not-found page', async ({ page }) => {
    const response = await page.goto(school('nope.localhost'));
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Site not found');
    expect(await cssVar(page, '--sh-color-accent')).toBe('#a3471c');
    await expectNoSeriousAxeViolations(page);
  });

  test('S-X08: a school that is still being set up shows "Coming soon" with its name only', async ({
    page,
  }) => {
    await page.goto(school('gamma.localhost'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Coming soon');
    await expect(page.getByText('Gamma Tutors is getting ready.')).toBeVisible();
    await expect(page.getByTestId('tenant-name')).toHaveCount(0);
    await expectNoSeriousAxeViolations(page);
  });

  test('S-X03: the offline fallback page renders in the school theme', async ({ page }) => {
    await page.goto(school('beta.localhost', '/offline'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("You're offline");
    await expectNoSeriousAxeViolations(page);
  });

  test('console host: the console shell with its fixed theme and realm strip, never a school brand', async ({
    page,
  }) => {
    await page.goto(school('console.localhost'));
    // Signed out, the console opens on its own sign-in page (M4), still in the console theme.
    await expect(page).toHaveURL(school('console.localhost', '/sign-in'));
    await expect(page.getByText('Platform console', { exact: true }).first()).toBeVisible();
    expect(await cssVar(page, '--sh-color-accent')).toBe('#1d5da6');
    await expect(page.locator('body')).not.toContainText(/Acme|Beta/);
    await expectNoSeriousAxeViolations(page);
  });

  test('the internal /_console route is not reachable from a school host', async ({ page }) => {
    const response = await page.goto(school('acme.localhost', '/_console'));
    expect(response?.status()).toBe(404);
  });
});
