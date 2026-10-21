import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DEMO, linkFromEmail, school, signIn, uniqueEmail } from './helpers';

// Requires `pnpm db:seed`: Acme has "Term 1" (open, with Biology foundations) and "Semester 2" (opens in
// about 90 days, with the free course "Chemistry for semester two"). docs/design/course-periods.md

const ACME = 'acme.localhost';
const COURSE_ID = '0d6c2b1e-0000-4000-8000-0000000cc004';
const COURSE = 'chemistry-semester-two';
const SEMESTER = '0d6c2b1e-0000-4000-8000-0000000c9002';
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

/** Sets Semester 2's opening switch on the Terms page, as the owner. */
async function setSemesterMode(page: Page, mode: 'Follow dates' | 'Open now'): Promise<void> {
  await signIn(page, ACME, DEMO.acmeOwner, '/admin/periods');
  const semester = page.getByTestId(`period-${SEMESTER}`);
  await semester.getByRole('combobox', { name: 'Opening' }).click();
  await page.getByRole('option', { name: mode }).click();
  await expect(
    mode === 'Open now' ? semester.getByText('Open', { exact: true }) : semester.getByText(/^Opens /),
  ).toBeVisible();
}

test.describe('course periods', () => {
  test.describe.configure({ mode: 'serial' });

  test('administrators see their terms and add one', async ({ page }) => {
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/periods');
    await expect(page.getByRole('heading', { name: 'Term 1' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Semester 2' })).toBeVisible();
    await expectNoSeriousAxeViolations(page);

    const name = `Seminar ${Date.now()}`;
    await page.getByLabel('Name').first().fill(name);
    await page.getByRole('combobox', { name: 'Type' }).first().click();
    await page.getByRole('option', { name: 'Seminar' }).click();
    await page.getByLabel('Opens on').first().fill('2031-02-03');
    await page.getByRole('button', { name: 'Add term' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    // Tidy up: archived terms leave the pickers.
    const added = page.locator('[data-testid^="period-"]', { has: page.getByRole('heading', { name }) });
    await added.getByRole('button', { name: 'Archive' }).click();
    await expect(added.getByText('Archived', { exact: true })).toBeVisible();
  });

  test('a learner enrols before the semester opens and meets locked lessons', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const email = uniqueEmail('periods');
    await page.context().clearCookies();
    await page.goto(school(ACME, '/sign-up'));
    await page.getByLabel('Full name').fill('Mutale Banda');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('checkbox', { name: /I agree/ }).click();
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');
    await page.goto(await linkFromEmail(email));
    await page.waitForURL(school(ACME, '/learn'));

    // The catalogue: filter by the semester; the card says when it opens.
    await page.goto(school(ACME, `/browse?period=${SEMESTER}`));
    const card = page.locator('article', {
      has: page.getByRole('link', { name: 'Chemistry for semester two' }),
    });
    await expect(card.getByText(/^Opens /)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Algebra essentials' })).toHaveCount(0);
    await expectNoSeriousAxeViolations(page);
    await page.goto(school(ACME, '/browse?period=open'));
    await expect(page.getByRole('link', { name: 'Algebra essentials' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Chemistry for semester two' })).toHaveCount(0);

    // Enrol now; the lessons stay closed until the semester starts.
    await page.goto(school(ACME, `/c/${COURSE}`));
    await expect(page.getByTestId('course-lock')).toContainText('Part of Semester 2');
    await page.getByRole('button', { name: 'Enrol for free' }).click();
    await page.waitForURL(/\/learn\/courses\/[0-9a-f-]{36}\/lessons\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/opens on .*Until then you can see the outline/).first()).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    await page.goto(school(ACME, `/learn/courses/${COURSE_ID}`));
    await page
      .getByRole('navigation', { name: 'Outline' })
      .first()
      .getByRole('link', { name: /The periodic table/ })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This lesson isn’t open yet');
    await expectNoSeriousAxeViolations(page);

    // The school opens the semester early (in another browser): the lesson opens.
    const ownerContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    await setSemesterMode(owner, 'Open now');
    await expectNoSeriousAxeViolations(owner);
    await ownerContext.close();
    await page.goto(school(ACME, `/learn/courses/${COURSE_ID}`));
    await page
      .getByRole('navigation', { name: 'Outline' })
      .first()
      .getByRole('link', { name: /The periodic table/ })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('The periodic table');
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext();
    await setSemesterMode(await context.newPage(), 'Follow dates');
    await context.close();
  });
});
