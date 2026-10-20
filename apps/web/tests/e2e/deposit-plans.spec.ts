import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DEMO, linkFromEmail, school, signIn, uniqueEmail } from './helpers';

// Requires `pnpm db:seed`: Acme has the fake payment account, revenue share with the demo tutor's payout
// method, and the paid course "Statistics in practice" (K250.00, two lessons) by the demo tutor.
// docs/design/payment-plans.md

const ACME = 'acme.localhost';
const COURSE_ID = '0d6c2b1e-0000-4000-8000-0000000cc003';
const COURSE = 'statistics-in-practice';
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

/** Turns the school's deposit plans on or off in Settings → Payments, as the owner. */
async function setDepositPlans(page: Page, enabled: boolean): Promise<void> {
  await signIn(page, ACME, DEMO.acmeOwner, '/admin/settings');
  const form = page.locator('form', { has: page.getByTestId('deposit-rules') });
  const toggle = form.getByRole('checkbox', { name: /Let instructors offer a deposit/ });
  if ((await toggle.isChecked()) !== enabled) await toggle.click();
  if (enabled) {
    await form.getByLabel('Smallest deposit (% of the price)').fill('20');
    await form.getByLabel('Longest time to pay the balance (days)').fill('90');
  }
  await form
    .getByLabel('Reason for the change')
    .fill(enabled ? 'Deposits for exam courses' : 'End of the e2e run');
  await form.getByRole('button', { name: 'Save payment settings' }).click();
  await expect(page.getByText('Payment settings saved.')).toBeVisible();
}

async function payOnPhone(page: Page, amount: string): Promise<void> {
  await page.waitForURL(/\/learn\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('order-total')).toContainText(amount);
  await page.getByLabel('Mobile number').fill('097 123 4567');
  await page.getByTestId('pay').click();
  await page.getByTestId('simulated-phone').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('payment-success')).toBeVisible({ timeout: 30_000 });
}

test.describe('deposit payment plans', () => {
  test.describe.configure({ mode: 'serial' });

  test('the school allows plans and the tutor offers one on the pricing page', async ({ page }) => {
    test.setTimeout(90_000);
    await setDepositPlans(page, true);
    await expectNoSeriousAxeViolations(page);

    await signIn(page, ACME, DEMO.acmeTutor, `/studio/courses/${COURSE_ID}/pricing`);
    await page.getByRole('radio', { name: /a deposit now and the balance later/ }).check();
    const plan = page.getByTestId('deposit-plan');
    await plan.getByLabel('Deposit (K)').fill('100');
    await plan.getByLabel('Lessons the deposit opens (%)').fill('50');
    await plan.getByLabel('Days to pay the balance').fill('30');
    await expect(page.getByTestId('deposit-preview')).toContainText('K100.00 now and K150.00 within 30 days');
    await expectNoSeriousAxeViolations(page);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  });

  test('a learner pays the deposit, meets a locked lesson, then pays the balance', async ({ page }) => {
    test.setTimeout(180_000);
    const email = uniqueEmail('deposit');
    await page.context().clearCookies();
    await page.goto(school(ACME, '/sign-up'));
    await page.getByLabel('Full name').fill('Chanda Mwila');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('checkbox', { name: /I agree/ }).click();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');
    await page.goto(await linkFromEmail(email));
    await page.waitForURL(school(ACME, '/learn'));

    await page.goto(school(ACME, `/c/${COURSE}`));
    await expect(page.getByTestId('course-deposit')).toHaveText(/Pay a deposit of .*100\.00/);
    await expect(page.getByText(/opens 50% of the lessons now/)).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    await page.getByTestId('course-deposit').click();
    await payOnPhone(page, '100.00');

    // The player: the first lesson is open, the second is locked behind the balance.
    await page.goto(school(ACME, `/learn/courses/${COURSE_ID}`));
    await page.waitForURL(/\/lessons\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Averages');
    await expect(page.getByText(/Your deposit opened 50% of this/).first()).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    await page
      .getByRole('navigation', { name: 'Outline' })
      .first()
      .getByRole('link', { name: /Spread/ })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'This lesson opens when you pay the balance',
    );
    await expectNoSeriousAxeViolations(page);

    // The course page offers the balance; paying it opens everything.
    await page.getByRole('link', { name: 'Pay the balance' }).first().click();
    await expect(page.getByTestId('course-balance')).toContainText(/150\.00/);
    await expectNoSeriousAxeViolations(page);
    await page.getByRole('button', { name: /Pay the balance/ }).click();
    await payOnPhone(page, '150.00');
    await page.goto(school(ACME, `/c/${COURSE}`));
    await expect(page.getByTestId('course-balance')).toHaveCount(0);
    await page.goto(school(ACME, '/account/purchases'));
    await expect(page.getByTestId('purchases')).toContainText('Statistics in practice (deposit)');
    await expect(page.getByTestId('purchases')).toContainText('Statistics in practice (balance)');
  });

  test('admins see each part; switching plans off keeps the tutor’s plan but stops offering it', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/orders');
    await expect(page.getByTestId('orders')).toContainText('Statistics in practice (balance)');
    await setDepositPlans(page, false);
    // The tutor's saved plan is kept but no longer offered.
    await signIn(page, ACME, DEMO.acmeTutor, `/studio/courses/${COURSE_ID}/pricing`);
    await expect(page.getByText(/switched deposit plans off/)).toBeVisible();
  });
});
