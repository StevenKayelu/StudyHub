import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import type { ConfigurationView } from '@studyhub/contracts';

import { DEMO, school, signIn } from './helpers';

// Requires `pnpm db:seed`. Other test files run in parallel against the same demo schools, so this file
// changes nothing they read: branding stays a draft and is restored. The activation journey below
// requires the disposable isolated stack and restores the original setting. Console screens are
// checked in identity.spec.ts, after its one staff sign-in.

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
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith('/api/v1/admin/configuration/draft')) {
        writes.push(request.url());
      }
    });
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/settings');
    await page.waitForLoadState('networkidle'); // controlled inputs: act only once hydrated
    const form = page.getByTestId('configuration-editor');
    await form.getByLabel('Reason for this configuration change').fill('');
    await form.getByRole('button', { name: 'Save configuration draft' }).click();
    await expect(form.getByRole('alert')).toBeVisible();
    await expect(form.getByRole('alert')).toHaveText('Enter a reason before saving the draft.');
    expect(writes).toEqual([]);
  });

  test('reviewed school configuration activates only for Acme and can reset to inheritance', async ({
    page,
    browser,
  }) => {
    test.skip(
      process.env.STUDYHUB_E2E_ISOLATED !== '1',
      'This mutation journey requires the disposable stack.',
    );
    test.setTimeout(90_000);
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/settings');
    await page.waitForLoadState('networkidle');
    // Chromium resolves *.localhost; Node's APIRequestContext does not on all Windows hosts.
    const readConfiguration = (browserPage: Page): Promise<ConfigurationView> =>
      browserPage.evaluate(async () => {
        const response = await fetch('/api/v1/admin/configuration', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Configuration read failed: ${response.status}`);
        return response.json();
      });
    const before = await readConfiguration(page);
    const editor = page.getByTestId('configuration-editor');
    const target =
      before.fields.find((field) => field.key === 'catalogVisibility')!.value === 'PUBLIC'
        ? 'MEMBERS_ONLY'
        : 'PUBLIC';
    const choose = async (value: string) => {
      await editor.getByRole('combobox', { name: 'Proposed catalogue visibility', exact: true }).click();
      await page
        .getByRole('option', {
          name: value === 'inherit' ? /^Inherit/ : value === 'PUBLIC' ? 'Public' : 'Members only',
          exact: value !== 'inherit',
        })
        .click();
    };
    const saveAndActivate = async (reason: string) => {
      await editor.getByLabel('Reason for this configuration change').fill(reason);
      await editor.getByRole('button', { name: 'Save configuration draft' }).click();
      await expect(
        editor.getByText('Draft saved. Review the proposed settings before activation.', { exact: true }),
      ).toBeVisible();
      await editor.getByRole('button', { name: 'Activate saved draft' }).click();
      await expect(editor.getByText('Configuration activated.', { exact: true })).toBeVisible();
    };
    await choose(target);
    await saveAndActivate('Browser verifies Acme-only policy');
    const active = await readConfiguration(page);
    expect(active.values.catalogVisibility).toBe(target);
    await page.reload();
    await expect(page.getByTestId('configuration-review')).toContainText(
      target === 'PUBLIC' ? 'Public' : 'Members only',
    );
    const betaContext = await browser.newContext();
    try {
      const beta = await betaContext.newPage();
      await signIn(beta, 'beta.localhost', DEMO.betaOwner, '/admin/settings');
      const betaState = await readConfiguration(beta);
      expect(betaState.values).toEqual({});
      expect(betaState.fields.find((field) => field.key === 'catalogVisibility')!.value).toBe('PUBLIC');
    } finally {
      await betaContext.close();
    }
    await choose(before.values.catalogVisibility ?? 'inherit');
    await saveAndActivate('Restore original browser-test policy');
    expect((await readConfiguration(page)).values).toEqual(before.values);
  });

  test('configuration import needs review, inheritance removes overrides, and conflicts keep edits', async ({
    page,
  }) => {
    const writes: Record<string, unknown>[] = [];
    const previews: { text: string }[] = [];
    await page.route('**/api/v1/admin/configuration/draft', async (route) => {
      writes.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify({ code: 'CONFLICT', title: 'Configuration changed', status: 409 }),
      });
    });
    await page.route('**/api/v1/admin/configuration/import-preview', async (route) => {
      previews.push(route.request().postDataJSON() as { text: string });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          schemaVersion: 1,
          values: { catalogVisibility: 'MEMBERS_ONLY' },
          entries: [
            { key: 'SCHOOL_CATALOG_VISIBILITY', setting: 'catalogVisibility', displayValue: 'MEMBERS_ONLY' },
          ],
        }),
      });
    });
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/settings');
    await page.waitForLoadState('networkidle');
    const editor = page.getByTestId('configuration-editor');
    for (const label of [
      'Proposed catalogue visibility',
      'Proposed course review required',
      'Proposed allow downloads on new lessons',
    ]) {
      await editor.getByRole('combobox', { name: label, exact: true }).click();
      await page.getByRole('option', { name: /^Inherit/ }).click();
    }
    await editor.getByText('Import a configuration file', { exact: true }).click();
    await editor.getByLabel('Configuration file (.env)').setInputFiles({
      name: '.env',
      mimeType: 'text/plain',
      buffer: Buffer.from('SCHOOL_CATALOG_VISIBILITY=MEMBERS_ONLY\n'),
    });
    await expect(editor.getByTestId('configuration-import-preview')).toContainText('MEMBERS_ONLY');
    expect(previews).toEqual([{ text: 'SCHOOL_CATALOG_VISIBILITY=MEMBERS_ONLY\n' }]);
    expect(writes).toEqual([]);
    await editor.getByRole('button', { name: 'Use preview in draft' }).click();
    await expect(
      editor.getByTestId('configuration-review').getByRole('row').filter({ hasText: 'Catalogue visibility' }),
    ).toContainText('Members only');
    expect(writes).toEqual([]);
    await expect(editor.getByRole('button', { name: 'Activate saved draft' })).toBeDisabled();
    await editor.getByLabel('Reason for this configuration change').fill('Review imported content defaults');
    await editor.getByRole('button', { name: 'Save configuration draft' }).click();
    await expect(editor.getByRole('alert')).toContainText('Configuration changed');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      values: { catalogVisibility: 'MEMBERS_ONLY' },
      lockedKeys: [],
      reason: 'Review imported content defaults',
    });
    expect(writes[0]?.values).toEqual({ catalogVisibility: 'MEMBERS_ONLY' });
    await expect(editor.getByLabel('Reason for this configuration change')).toHaveValue(
      'Review imported content defaults',
    );
    await expect(editor.getByRole('combobox', { name: 'Proposed catalogue visibility' })).toContainText(
      'Members only',
    );
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
