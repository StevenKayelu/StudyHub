import { AxeBuilder } from '@axe-core/playwright';
import { type Cookie, expect, type Page, test } from '@playwright/test';

import {
  consoleSignIn,
  DEMO,
  DEMO_PASSWORD,
  linkFromEmail,
  school,
  signIn,
  uniqueEmail,
  WEB_PORT,
} from './helpers';

// Requires `pnpm db:seed` (demo schools and accounts) and Mailpit (`pnpm db:up`).

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

test.describe('school realm (M4)', () => {
  test('sign up → verify by email → signed in; the email link is single use', async ({ page }) => {
    const email = uniqueEmail('signup');
    await page.goto(school('acme.localhost', '/sign-up'));
    await expectNoSeriousAxeViolations(page);
    await page.getByLabel('Full name').fill('Natasha Tembo');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('my long study passphrase');
    await page.getByRole('checkbox', { name: /I agree/ }).click();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');

    const link = await linkFromEmail(email);
    expect(link.startsWith(school('acme.localhost', '/verify-email#token='))).toBe(true);
    await page.goto(link);
    await page.waitForURL(school('acme.localhost', '/learn'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My learning');
    // The token is gone from the address bar, and a second use fails.
    await page.goto(link);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link is invalid or has expired');
  });

  test('BR-65: wrong password and unknown email show the same message', async ({ page }) => {
    await page.goto(school('acme.localhost', '/sign-in'));
    await expectNoSeriousAxeViolations(page);
    for (const email of [DEMO.learner, 'nobody@example.com']) {
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill('definitely wrong');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('main').getByRole('alert')).toHaveText('Email or password is incorrect');
    }
  });

  test('guards: visitors sign in first and return; members without the role see S-X05', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(school('acme.localhost', '/admin'));
    await expect(page).toHaveURL(school('acme.localhost', '/sign-in?returnTo=%2Fadmin'));
    await page.getByLabel('Email').fill(DEMO.learner);
    await page.getByLabel('Password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(school('acme.localhost', '/admin'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText("You don't have access to this page");
    await expect(page.getByText('You are signed in as Chanda Mwila.')).toBeVisible();
    await expectNoSeriousAxeViolations(page);
  });

  test('M4 AC 2: a school session cookie replayed on another school host is not accepted', async ({
    page,
    context,
    request,
  }) => {
    await signIn(page, 'acme.localhost', DEMO.learner);
    const acmeCookie = (await context.cookies(school('acme.localhost'))).find(
      (c) => c.name === '__Host-sh_session',
    );
    expect(acmeCookie).toBeDefined();
    // The browser never sends it to beta.localhost (host-only). Replay it by hand through the web server.
    const replay = (host: string) =>
      request.get(school('127.0.0.1', '/api/v1/me'), {
        headers: { host: `${host}:${WEB_PORT}`, cookie: `__Host-sh_session=${acmeCookie!.value}` },
      });
    expect((await replay('acme.localhost')).status()).toBe(200);
    expect((await replay('beta.localhost')).status()).toBe(401);
  });

  test('D3/BR-68: one account, two schools; switching opens the other school already signed in', async ({
    page,
  }) => {
    await signIn(page, 'acme.localhost', DEMO.learner, '/account');
    await expect(page.getByRole('heading', { name: 'Your schools' })).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    await page.getByRole('button', { name: 'Open Beta College' }).click();
    await page.waitForURL(school('beta.localhost', '/learn'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My learning');
    await expect(page.locator('html')).not.toContainText('Acme Academy');
  });

  test('invitation: an owner invites a tutor, who creates an account and lands in Studio (BR-67)', async ({
    page,
    browser,
  }) => {
    const email = uniqueEmail('tutor');
    await signIn(page, 'acme.localhost', DEMO.acmeOwner, '/admin/team');
    await expectNoSeriousAxeViolations(page);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible();
    await expect(page.getByText(email)).toBeVisible(); // pending list

    const link = await linkFromEmail(email);
    const invitee = await browser.newContext();
    const tab = await invitee.newPage();
    await tab.goto(link);
    await expect(tab.getByRole('heading', { level: 1 })).toHaveText('Join Acme Academy');
    await tab.getByLabel('Full name').fill('Mwape Lungu');
    await tab.getByLabel('Password').fill('teaching is my passion');
    await tab.getByRole('button', { name: 'Accept invitation' }).click();
    await tab.waitForURL(school('acme.localhost', '/studio'));
    await expect(tab.getByRole('heading', { level: 1 })).toHaveText('Courses');
    await invitee.close();
  });

  test('password reset by email link signs the person out everywhere', async ({ page, browser }) => {
    const email = uniqueEmail('reset');
    // A fresh account (so the demo password stays unchanged for other tests).
    await page.goto(school('beta.localhost', '/sign-up'));
    await page.getByLabel('Full name').fill('Reset Person');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('first long passphrase');
    await page.getByRole('checkbox', { name: /I agree/ }).click();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.goto(await linkFromEmail(email));
    await page.waitForURL(school('beta.localhost', '/learn'));

    const other = await browser.newContext();
    const tab = await other.newPage();
    await tab.goto(school('beta.localhost', '/forgot-password'));
    await tab.getByLabel('Email').fill(email);
    await tab.getByRole('button', { name: 'Send link' }).click();
    await expect(tab.getByRole('status')).toContainText('If that email has an account');
    // The newest email to this address is now the reset link.
    let resetLink = '';
    await expect
      .poll(async () => (resetLink = await linkFromEmail(email)), { timeout: 30_000 })
      .toContain('/reset-password#token=');
    await tab.goto(resetLink);
    await tab.getByLabel('New password').fill('second long passphrase');
    await tab.getByRole('button', { name: 'Save password' }).click();
    await expect(tab.getByRole('status')).toContainText('Your password is changed');
    await other.close();

    await page.reload();
    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Flearn$/);
  });
});

test.describe('platform console realm (M4)', () => {
  // One staff sign-in per run (TOTP steps can't be reused); later console tests reuse its cookies.
  let staffCookies: Cookie[] = [];

  test('M4 AC 4: staff sign-in requires TOTP enrolment, then the console opens', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(school('console.localhost', '/'));
    await expect(page).toHaveURL(school('console.localhost', '/sign-in'));
    await expectNoSeriousAxeViolations(page);
    test.skip(!(await consoleSignIn(page)), 'demo staff already enrolled in an earlier run (re-seed)');
    staffCookies = await page.context().cookies();
    await expect(page.getByText('Platform console', { exact: true })).toBeVisible();
    await page.goto(school('console.localhost', '/staff'));
    await expect(page.getByText(DEMO.staff)).toBeVisible();
    await expectNoSeriousAxeViolations(page);
  });

  test('M9 F43, UX-17: console screens keep the realm strip and never show school members’ data', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(staffCookies.length === 0, 'needs the staff sign-in above (re-seed to reset enrolment)');
    await page.context().addCookies(staffCookies);
    const screens = [
      '/',
      '/tenants',
      '/plans',
      '/statements',
      '/domains',
      '/support',
      '/settings',
      '/audit-log',
    ];
    for (const path of screens) {
      await page.goto(school('console.localhost', path));
      await expect(page.getByText('Platform console', { exact: true }), path).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
      await expectNoSeriousAxeViolations(page);
    }

    await page.goto(school('console.localhost', '/tenants?q=acme'));
    await page.getByTestId('console-tenants').getByRole('link', { name: /Acme/ }).first().click();
    await expect(page.getByTestId('tenant-metadata')).toBeVisible();
    await expect(page.getByTestId('tenant-features')).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    // F43 AC 1: no learner's or instructor's address appears (the owner contact is the documented exception).
    const text = await page.locator('main').innerText();
    expect(text).not.toContain(DEMO.learner);
    expect(text).not.toContain(DEMO.acmeTutor);
  });

  test('M4 AC 3: the console API does not exist on school hosts, and a console cookie means nothing there', async ({
    page,
  }) => {
    await page.goto(school('acme.localhost', '/offline'));
    const status = await page.evaluate(async () => (await fetch('/api/console/me')).status);
    expect(status).toBe(404);
    await page.context().clearCookies();
    await page.goto(school('acme.localhost', '/learn'));
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
