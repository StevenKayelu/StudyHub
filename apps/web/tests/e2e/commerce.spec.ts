import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DEMO, linkFromEmail, school, signIn, uniqueEmail } from './helpers';

// Requires `pnpm db:seed`: Acme has the fake payment account (active, FULL profile), instructor revenue
// share, and the paid course "Statistics in practice" (K250.00) by the demo tutor.

const ACME = 'acme.localhost';
const PAID_COURSE = 'statistics-in-practice';
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

/** A new, verified learner for this run (so reruns never find the course already bought). */
async function newLearner(page: Page, name: string): Promise<string> {
  const email = uniqueEmail('buyer');
  await page.context().clearCookies();
  await page.goto(school(ACME, '/sign-up'));
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('checkbox', { name: /I agree/ }).click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');
  await page.goto(await linkFromEmail(email));
  await page.waitForURL(school(ACME, '/learn'));
  return email;
}

async function signInAs(page: Page, email: string, returnTo: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto(school(ACME, `/sign-in?returnTo=${encodeURIComponent(returnTo)}`));
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(school(ACME, returnTo));
}

test.describe('commerce (M8)', () => {
  test.describe.configure({ mode: 'serial' });
  let learner = '';
  let orderUrl = '';

  test('buy with mobile money: checkout → approve on the (simulated) phone → enrolled → receipt (F25, F27)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    learner = await newLearner(page, 'Mutale Banda');
    await page.goto(school(ACME, `/c/${PAID_COURSE}`));
    await expect(page.getByTestId('course-price')).toContainText('250.00');
    await page.getByRole('button', { name: /Buy for/ }).click();
    await page.waitForURL(/\/learn\/orders\/[0-9a-f-]{36}$/);
    orderUrl = page.url();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Checkout');
    await expect(page.getByTestId('order-total')).toContainText('250.00');
    await expectNoSeriousAxeViolations(page);

    await page.getByLabel('Mobile number').fill('097 123 4567');
    await expect(page.getByText('Airtel detected from the number', { exact: false })).toBeVisible();
    await page.getByTestId('pay').click();
    await expect(page.getByTestId('payment-waiting')).toBeVisible();
    await expect(page.getByText(/Approve .*250\.00 with your PIN on \+260 97 ••• 567/)).toBeVisible();
    await expectNoSeriousAxeViolations(page);

    // The development provider's simulated phone stands in for the learner's handset.
    await page.getByTestId('simulated-phone').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('payment-success')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('payment-success')).toContainText(/Receipt ACME-\d{4}-\d{6}/);
    await expectNoSeriousAxeViolations(page);

    await page.getByRole('link', { name: 'View receipt' }).click();
    await expect(page.getByTestId('receipt')).toContainText('Acme Academy');
    await expect(page.getByTestId('receipt')).toContainText('Statistics in practice');
    await expect(page.getByTestId('receipt')).toContainText('+260 97 ••• 567');
    await expectNoSeriousAxeViolations(page);
    await page.goto(school(ACME, '/account/purchases'));
    await expect(page.getByTestId('purchases')).toContainText('Statistics in practice');

    // The course is open now.
    await page.goto(school(ACME, `/c/${PAID_COURSE}`));
    await expect(page.getByTestId('course-cta')).toHaveText(/Start learning|Continue/);
  });

  test('the owner refunds the order; the learner’s access ends (F28)', async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/orders');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Orders & payments');
    await expectNoSeriousAxeViolations(page);
    await page
      .getByTestId('orders')
      .getByRole('row')
      .filter({ hasText: 'Mutale Banda' })
      .first()
      .getByRole('link')
      .click();
    await expect(page.getByTestId('order-timeline')).toContainText('Payment confirmed');
    await expectNoSeriousAxeViolations(page);
    const refund = page.getByTestId('refund-form');
    await refund.getByRole('radio', { name: 'Through the payment provider' }).check();
    await refund.getByLabel('Reason').fill('Bought by mistake');
    await refund.getByRole('button', { name: /Refund/ }).click();
    await expect(page.getByText('Refunded').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('order-timeline')).toContainText('SUCCEEDED');

    await signInAs(page, learner, '/learn');
    await page.goto(orderUrl);
    await expect(page.getByText('This order was refunded and the access has ended.')).toBeVisible();
    await page.goto(school(ACME, `/c/${PAID_COURSE}`));
    await expect(page.getByRole('button', { name: /Buy for/ })).toBeVisible();
  });

  test('buy again by card on the provider’s hosted page; only the server confirms it (F25 AC 1)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signInAs(page, learner, `/c/${PAID_COURSE}`);
    await page.getByRole('button', { name: /Buy for/ }).click();
    await page.waitForURL(/\/learn\/orders\/[0-9a-f-]{36}$/);
    await page.getByRole('radio', { name: 'Card' }).check();
    await page.getByTestId('pay').click();
    await page.waitForURL(/\/api\/v1\/dev\/fake-pay\//);
    await expect(page.getByText('Development only.')).toBeVisible();
    await page.getByRole('button', { name: /^Pay / }).click();
    await page.waitForURL(/\/learn\/orders\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('payment-success')).toBeVisible({ timeout: 30_000 });
  });

  test('administration and Studio money screens (S-AD05, S-AD09, S-AD15, S-T11)', async ({ page }) => {
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/payments');
    await expect(page.getByTestId('payment-account').first()).toContainText('Active');
    await expect(page.locator('body')).not.toContainText('fake-demo-api-key');
    await expectNoSeriousAxeViolations(page);
    await page.goto(school(ACME, '/admin/settings'));
    await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    await page.goto(school(ACME, '/admin/payouts'));
    await expect(page.getByTestId('instructor-balances')).toContainText('Tiko Phiri');
    await expectNoSeriousAxeViolations(page);

    await signIn(page, ACME, DEMO.acmeTutor, '/studio/earnings');
    await expect(page.getByTestId('earnings-balances')).toBeVisible();
    await expect(page.getByTestId('payout-methods')).toContainText('MTN +260 96 ••• 233');
    await expectNoSeriousAxeViolations(page);
  });
});
