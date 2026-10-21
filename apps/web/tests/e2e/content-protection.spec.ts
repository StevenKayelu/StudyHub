import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DEMO, linkFromEmail, school, signIn, uniqueEmail } from './helpers';

// Requires `pnpm db:seed`: "Biology foundations" is a free published course by the demo tutor, protected
// by default (the school lets each tutor choose). docs/design/content-protection.md

const ACME = 'acme.localhost';
const COURSE_ID = '0d6c2b1e-0000-4000-8000-0000000cc001';
const PASSWORD = 'a long enough test passphrase';

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

test.describe('content protection', () => {
  test('a learner sees their name over protected lessons, which can’t be copied or printed', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const email = uniqueEmail('protect');
    await page.context().clearCookies();
    await page.goto(school(ACME, '/sign-up'));
    await page.getByLabel('Full name').fill('Natasha Phiri');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('checkbox', { name: /I agree/ }).click();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');
    await page.goto(await linkFromEmail(email));
    await page.waitForURL(school(ACME, '/learn'));

    await page.goto(school(ACME, '/c/biology-foundations'));
    await page.getByRole('button', { name: 'Enrol for free' }).click();
    await page.waitForURL(/\/learn\/courses\/[0-9a-f-]{36}\/lessons\/[0-9a-f-]{36}$/);

    // The watermark names the learner; the content can't be selected.
    await expect(page.getByTestId('watermark').first()).toHaveAttribute(
      'data-watermark',
      `Natasha Phiri · ${email}`,
    );
    const protectedBox = page.locator('[data-protected]');
    await expect(protectedBox).toHaveCSS('user-select', 'none');
    await expectNoSeriousAxeViolations(page);

    // Printing shows only the notice.
    await page.emulateMedia({ media: 'print' });
    await expect(protectedBox).toBeHidden();
    await expect(page.getByText('This lesson is protected and can’t be printed.')).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
    await expect(page.getByText('This lesson is protected and can’t be printed.')).toBeHidden();
  });

  test('the tutor sees the protection choice and previews without a watermark', async ({ page }) => {
    await signIn(page, ACME, DEMO.acmeTutor, `/studio/courses/${COURSE_ID}/details`);
    await expect(page.getByLabel('Content protection')).toHaveValue('DEFAULT');
    await expectNoSeriousAxeViolations(page);
    await page.goto(school(ACME, `/learn/courses/${COURSE_ID}`));
    await page.waitForURL(/\/lessons\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('watermark')).toHaveCount(0);
  });
});
