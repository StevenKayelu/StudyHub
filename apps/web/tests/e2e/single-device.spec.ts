import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { linkFromEmail, school, uniqueEmail } from './helpers';

// One device at a time for learners (docs/design/single-device-learners.md). Uses a new learner, so it
// never signs out a demo account another test is using.

const ACME = 'acme.localhost';
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

test('a learner signing in on a second device signs out the first, which is told why', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const email = uniqueEmail('one-device');
  await page.context().clearCookies();
  await page.goto(school(ACME, '/sign-up'));
  await page.getByLabel('Full name').fill('Bwalya Zulu');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('checkbox', { name: /I agree/ }).click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');
  await page.goto(await linkFromEmail(email));
  await page.waitForURL(school(ACME, '/learn'));

  // A second device (another browser) signs in to the same account.
  const otherDevice = await browser.newContext();
  const other = await otherDevice.newPage();
  await other.goto(school(ACME, '/sign-in?returnTo=%2Flearn'));
  await other.getByLabel('Email').fill(email);
  await other.getByLabel('Password').fill(PASSWORD);
  await other.getByRole('button', { name: 'Sign in' }).click();
  await other.waitForURL(school(ACME, '/learn'));

  // The first device is signed out at its next page and told why.
  await page.goto(school(ACME, '/learn'));
  await page.waitForURL(/\/sign-in\?/);
  await expect(page.getByTestId('signed-in-elsewhere')).toContainText(
    'Your account was signed in on another device',
  );
  await expectNoSeriousAxeViolations(page);

  // The second device carries on.
  await other.goto(school(ACME, '/account'));
  await expect(other).toHaveURL(school(ACME, '/account'));
  await otherDevice.close();
});
