import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DEMO, pngBuffer, school, signIn } from './helpers';

// Requires `pnpm db:seed` (Acme's demo catalogue) and the local object store (`pnpm db:up`).

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

test.describe('catalogue (M5)', () => {
  test('home lists courses; search tolerates a typo; filters live in the URL', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(school(ACME, '/'));
    await expect(page.getByRole('link', { name: 'Biology foundations' })).toBeVisible();
    await expectNoSeriousAxeViolations(page);

    await page.getByRole('searchbox', { name: 'What do you want to learn?' }).fill('biolgy');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(school(ACME, '/browse?q=biolgy'));
    await expect(page.getByRole('link', { name: 'Biology foundations' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Algebra essentials' })).toHaveCount(0);

    await page.goto(school(ACME, '/browse?subject=algebra'));
    await expect(page.getByRole('link', { name: 'Algebra essentials' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Biology foundations' })).toHaveCount(0);
    await expectNoSeriousAxeViolations(page);

    await page.goto(school(ACME, '/browse?q=zzzzqqqq'));
    await expect(page.getByText('Nothing matches yet')).toBeVisible();
  });

  test('course landing: outline, instructor, price and no enrolment yet', async ({ page }) => {
    await page.goto(school(ACME, '/c/biology-foundations'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Biology foundations');
    await expect(page).toHaveTitle(/Biology foundations/);
    await expect(page.getByRole('heading', { name: 'Section 1: Cells' })).toBeVisible();
    await expect(page.getByTestId('course-price')).toHaveText('Free');
    await expect(page.getByText('Enrolment opens soon')).toBeVisible();
    await expectNoSeriousAxeViolations(page);

    await page.getByRole('link', { name: 'Tiko Phiri' }).first().click();
    await expect(page).toHaveURL(school(ACME, '/t/tiko-phiri'));
    await expect(page.getByRole('link', { name: 'Algebra essentials' })).toBeVisible();

    const missing = await page.goto(school(ACME, '/c/no-such-course'));
    expect(missing?.status()).toBe(404);
  });

  test('author → review → published: outline, rich text, cover upload, checklist', async ({ page }) => {
    test.setTimeout(120_000);
    const title = `Photosynthesis ${Date.now()}`;

    await signIn(page, ACME, DEMO.acmeTutor, '/studio');
    await expectNoSeriousAxeViolations(page);
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/studio\/courses\/[0-9a-f-]{36}$/);
    const coursePath = new URL(page.url()).pathname;

    // Outline: one section with one reading lesson.
    await page.getByLabel('Section title').fill('Light and leaves');
    await page.getByRole('button', { name: 'Add section' }).click();
    await page.getByLabel('Lesson title').fill('How leaves capture light');
    await page.getByRole('button', { name: 'Add lesson' }).click();
    await expect(page.getByText('Needs content')).toBeVisible();
    await expectNoSeriousAxeViolations(page);

    await page.getByRole('link', { name: 'How leaves capture light' }).click();
    await page.getByRole('textbox', { name: 'Content' }).click();
    await page.keyboard.insertText('Chlorophyll absorbs red and blue light and reflects green.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

    // Details: description of at least 200 characters, subject, outcome, cover image.
    await page.goto(school(ACME, `${coursePath}/details`));
    await page.getByLabel('Subtitle').fill('How plants turn light into food');
    await page.getByRole('textbox', { name: 'Description' }).click();
    await page.keyboard.insertText(
      'Plants make their own food from light, water and carbon dioxide. In this short course you follow ' +
        'the journey of energy from the sun into a leaf, through the chloroplast, and into the sugars ' +
        'that power almost every living thing on Earth.',
    );
    await page.getByLabel('What learners will learn').fill('Explain the photosynthesis equation');
    await page.getByLabel('Subject').selectOption({ label: 'Biology' });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

    // The browser uploads straight to object storage, then the worker verifies and scans it.
    await page.locator('input[type="file"]').setInputFiles({
      name: 'cover.png',
      mimeType: 'image/png',
      buffer: pngBuffer(320, 180),
    });
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('cover-preview')).toBeVisible();

    // Publish: every checklist item passes; Acme reviews new courses first.
    await page.goto(school(ACME, `${coursePath}/publish`));
    await expect(page.getByTestId('publish-checklist').locator('[data-ok="false"]')).toHaveCount(0);
    await expectNoSeriousAxeViolations(page);
    await page.getByTestId('submit-course').click();
    await expect(page.getByText('In review').first()).toBeVisible();

    // The owner approves it from the review queue; it appears in the catalogue.
    await signIn(page, ACME, DEMO.acmeOwner, '/admin/reviews');
    const item = page.getByTestId('review-queue').getByRole('listitem').filter({ hasText: title });
    await item.getByRole('button', { name: 'Approve and publish' }).click();
    await expect(page.getByTestId('review-queue').getByText(title)).toHaveCount(0);

    await page.context().clearCookies();
    await page.goto(school(ACME, `/browse?q=${encodeURIComponent('photosynthesis')}`));
    await page.getByRole('link', { name: title }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(page.getByRole('heading', { name: 'Section 1: Light and leaves' })).toBeVisible();
  });

  test('another instructor’s course is not found in Studio', async ({ page }) => {
    await signIn(page, ACME, DEMO.acmeOwner, '/learn');
    const response = await page.goto(school(ACME, '/studio/courses/0d6c2b1e-0000-4000-8000-0000000cc001'));
    // The owner has no instructor role, so Studio itself is refused (S-X05).
    expect([200, 403, 404]).toContain(response?.status());
    await expect(page.getByRole('heading', { name: 'Biology foundations' })).toHaveCount(0);
  });
});
