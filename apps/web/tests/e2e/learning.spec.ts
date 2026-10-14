import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';

import { DEMO, school, signIn } from './helpers';

// Requires `pnpm db:seed`: Acme's demo catalogue (Algebra essentials with a video lesson) and the
// suspended Delta school with the demo learner enrolled.

const ACME = 'acme.localhost';
const DELTA = 'delta.localhost';
const ALGEBRA_ID = '0d6c2b1e-0000-4000-8000-0000000cc002';

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

/** The school owner revokes the demo learner's Algebra access (also exercises the admin screen). */
async function revokeLearnerAccess(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, ACME, DEMO.acmeOwner, `/admin/courses/${ALGEBRA_ID}/access`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Access to Algebra essentials');
  const active = page.getByRole('listitem').filter({ hasText: 'Chanda Mwila' }).filter({ hasText: 'Active' });
  while ((await active.count()) > 0) {
    const row = active.first();
    await row.getByRole('button', { name: 'Revoke' }).click();
    await row.getByLabel('Reason for revoking').fill('Reset by the end-to-end test');
    await row.getByRole('button', { name: 'Revoke access' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Revoked' }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
  }
  await context.close();
}

const savedProgress = (page: Page) =>
  page.waitForResponse(
    (response) => response.url().includes('/progress') && response.request().method() === 'PUT',
  );

test.describe('learning (M6)', () => {
  test('enrol, learn, resume within seconds and complete (F14–F16, AC 2)', async ({ page, browser }) => {
    test.setTimeout(90_000); // several pages, an admin session and a video lesson
    await revokeLearnerAccess(browser);

    await signIn(page, ACME, DEMO.learner, '/c/algebra-essentials');
    const cta = page.getByTestId('course-cta');
    await expect(cta).toHaveText('Enrol for free');
    await cta.click();
    await page.waitForURL(/\/learn\/courses\/[0-9a-f-]{36}\/lessons\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Like terms');
    await expect(page.getByRole('navigation', { name: 'Outline' }).first()).toBeVisible();
    await expectNoSeriousAxeViolations(page);

    await page.getByRole('button', { name: 'Mark complete' }).click();
    await expect(page.getByTestId('lesson-state')).toHaveText('Completed');
    await page.getByRole('link', { name: 'Next: Brackets' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Brackets');
    // ← goes back a lesson (S-L02), → forward again.
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Like terms');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Brackets');
    await page.getByRole('button', { name: 'Mark complete' }).click();
    await expect(page.getByTestId('lesson-state')).toHaveText('Completed');

    await page.getByRole('link', { name: 'Next: Graphs in motion' }).click();
    await expect(page.getByTestId('simulated-video')).toBeVisible();
    await expect(page.getByTestId('lesson-state')).toHaveText('Completes when you’ve watched 90%');
    const slider = page.getByRole('slider', { name: 'Position' });
    const saved = savedProgress(page);
    await slider.fill('40');
    expect((await saved).ok()).toBe(true);

    // A new page (as after switching devices) resumes at the saved second (AC 2: within ±5 s).
    await page.goto(school(ACME, '/learn'));
    const card = page.getByTestId('continue-card');
    await expect(card).toContainText('Graphs in motion');
    await expect(card).toContainText('at 0:40');
    await expectNoSeriousAxeViolations(page);
    await card.getByRole('link', { name: 'Resume' }).click();
    await expect(page.getByRole('slider', { name: 'Position' })).toHaveValue('40');

    // Reaching the threshold completes the lesson, and with it the course (BR-22).
    await page.getByRole('slider', { name: 'Position' }).fill('115');
    await page.waitForURL(school(ACME, `/learn/courses/${ALGEBRA_ID}/complete`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('You’ve completed Algebra essentials');

    await page.goto(school(ACME, '/learn/courses?show=completed'));
    await expect(page.getByRole('link', { name: 'Algebra essentials' })).toBeVisible();
  });

  test('preview lessons are open to visitors; everything else asks to enrol (F15 AC 2)', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(school(ACME, '/c/biology-foundations'));
    await expect(page.getByTestId('course-cta')).toHaveText('Sign in to enrol');
    await page.getByRole('link', { name: 'Preview What is a cell?' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Preview: What is a cell?');
    await expect(page.getByText('What is a cell?: demo reading.')).toBeVisible();
    await expectNoSeriousAxeViolations(page);

    const locked = await page.goto(school(ACME, `/learn/courses/${ALGEBRA_ID}`));
    expect(locked?.url()).toContain('/sign-in');
  });

  test('the instructor previews as a learner and sees who is enrolled (S-T09)', async ({ page }) => {
    await signIn(page, ACME, DEMO.acmeTutor, `/studio/courses/${ALGEBRA_ID}/learners`);
    await expect(page.getByRole('row').filter({ hasText: 'Chanda Mwila' }).first()).toBeVisible();
    await page.getByRole('link', { name: 'Preview as learner' }).click();
    await page.waitForURL(/\/learn\/courses\/.+\/lessons\/.+/);
    await expect(page.getByText('You’re previewing as the tutor. Progress isn’t recorded.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark complete' })).toHaveCount(0);
  });

  test('a suspended school is read-only; its learners still reach their course (AC 3, BR-52)', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto(school(DELTA, '/'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This site is temporarily unavailable');
    await page.getByRole('link', { name: 'Sign in to continue learning' }).click();
    await page.waitForURL(/\/sign-in\?/); // fully loaded (and hydrated) before typing
    await page.getByLabel('Email').fill(DEMO.learner);
    await page.getByLabel('Password').fill('studyhub-demo-pass');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(school(DELTA, '/learn'));

    await page.getByTestId('continue-card').getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ancient empires');
    await expect(
      page.getByText(
        'This school is read-only for now. You can read everything, but your progress isn’t saved.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark complete' })).toHaveCount(0);

    // Client-side navigation out of the learner space lands on S-X07 too.
    await page.goto(school(DELTA, '/learn'));
    await page.getByRole('link', { name: 'Browse' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This site is temporarily unavailable');

    await page.goto(school(DELTA, '/browse'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This site is temporarily unavailable');
    await expect(page.getByRole('link', { name: 'Go to my learning' })).toBeVisible();
  });
});
