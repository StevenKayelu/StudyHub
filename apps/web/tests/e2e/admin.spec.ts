import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DEMO, school, signIn } from './helpers';

// Requires `pnpm db:seed`. Other test files run in parallel against the same demo schools, so this file
// changes nothing they read: branding stays a draft and is restored, and settings are submitted without
// a reason (refused). The console screens are checked in identity.spec.ts, after its one staff sign-in.

const ACME = 'acme.localhost';

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

test.describe('tenant administration (M9)', () => {
  const SCREENS: [string, string][] = [
    ['/admin/branding', 'Branding'],
    ['/admin/domain', 'Domain'],
    ['/admin/billing', 'Billing'],
    ['/admin/data', 'Data & offboarding'],
    ['/admin/reconciliation', 'Payment reconciliation'],
    ['/admin/settings', 'Settings'],
    ['/admin/usage', 'Usage & plan'],
    ['/admin/support-access', 'Support access'],
    ['/admin/audit-log', 'Audit log'],
    ['/account/notifications', 'Notifications'],
  ];

  test('every M9 school screen renders for the owner with no serious axe violations', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, ACME, DEMO.acmeOwner, '/admin');
    for (const [path, heading] of SCREENS) {
      await page.goto(school(ACME, path));
      await expect(page.getByRole('heading', { level: 1 }), path).toContainText(heading);
      await expectNoSeriousAxeViolations(page);
    }
  });

  test('UX-14 (F39, BR-51): the colour check reports contrast and suggests fixes; drafts save', async ({
    page,
  }) => {
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/branding');
    await page.waitForLoadState('networkidle'); // controlled inputs: act only once hydrated
    const accent = page.getByRole('textbox', { name: 'Accent colour' });
    const original = await accent.inputValue();
    await accent.fill('#ffee00');
    await page.getByTestId('check-colour').click();
    const checks = page.getByTestId('contrast-checks');
    await expect(checks).toBeVisible();
    await expect(checks.getByText('Light theme')).toBeVisible();
    await expect(checks.getByText('Dark theme')).toBeVisible();
    await expect(page.getByTestId('branding-preview')).toBeVisible();

    // The draft round-trips through the API; restore the original so nothing else sees a change.
    await accent.fill(original);
    await page.getByTestId('save-branding').click();
    await expect(page.getByText('Draft saved')).toBeVisible();
  });

  test('F41 AC 2: a settings change needs a reason', async ({ page }) => {
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/settings');
    await page.waitForLoadState('networkidle'); // controlled inputs: act only once hydrated
    const form = page.getByTestId('settings-catalogue');
    await form.getByRole('button', { name: 'Save catalogue' }).click();
    await expect(form.getByRole('alert')).toBeVisible();
    await expect(form.getByText('Saved')).toHaveCount(0);
  });

  test('S-AD19: the domain screen shows the address and checks a new one before sending', async ({
    page,
  }) => {
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/domain');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('domains')).toContainText('acme.localhost');
    await page.getByLabel('New address').fill('console');
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByTestId('slug-status')).toHaveText('That address is reserved.');
  });
});
