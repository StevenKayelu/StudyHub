import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DEMO, school, signIn } from './helpers';

// Requires `pnpm db:seed`: Biology foundations has the "Cells check" quiz (3 questions, pass mark 50 %)
// and the demo learner is enrolled.

const ACME = 'acme.localhost';
const BIOLOGY_ID = '0d6c2b1e-0000-4000-8000-0000000cc001';
const QUIZ_ID = '0d6c2b1e-0000-4000-8000-0000000ce001';
const SECRETS = /isCorrect|acceptedAnswers|explanation|Mitochondria carry out|Plant cells have a cell wall/;
// The page also carries the UI's own labels (e.g. the "Explanation" heading text), so the bare word is not
// a leak there; the answers' fields and texts are.
const PAGE_SECRETS =
  /isCorrect|acceptedAnswers|"explanation(Json)?\\?":\s*\{|Mitochondria carry out|Plant cells have a cell wall/;

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

/** Opens the quiz intro and starts (or resumes, after an interrupted run) an attempt. */
async function openAttempt(page: Page): Promise<void> {
  await signIn(page, ACME, DEMO.learner, `/learn/quizzes/${QUIZ_ID}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cells check');
  const resume = page.getByTestId('resume-attempt');
  if (await resume.isVisible()) await resume.click();
  else await page.getByTestId('start-attempt').click();
  await page.waitForURL(/\/learn\/attempts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Question 1 of 3' })).toBeAttached();
}

test.describe('assessment (M7)', () => {
  test('answers survive going offline, sync on reconnect, and nothing leaks before submitting (AC 2, AC 5)', async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const bodies: string[] = [];
    page.on('response', async (response) => {
      if (
        /\/api\/v1\/learn\/(attempts|quizzes)\//.test(response.url()) &&
        !response.url().endsWith('/result')
      ) {
        bodies.push(await response.text().catch(() => ''));
      }
    });
    await openAttempt(page);
    // The runner page itself (server-rendered with the attempt) carries no answers either (F19 AC 2).
    expect(await page.content()).not.toMatch(PAGE_SECRETS);
    await expectNoSeriousAxeViolations(page);

    await page.getByRole('radio', { name: /Mitochondrion/ }).check();
    await expect(page.getByTestId('save-state')).toHaveText('All answers saved', { timeout: 10_000 });

    await context.setOffline(true);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('checkbox', { name: /Cell wall/ }).check();
    await page.getByRole('checkbox', { name: /Chloroplast/ }).check();
    await expect(page.getByText('You’re offline.', { exact: false })).toBeVisible();
    await expect(page.getByTestId('save-state')).toHaveText('1 answer not synced');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Your answer').fill('Cell');
    await expect(page.getByTestId('save-state')).toHaveText('2 answers not synced');

    // A reload while offline would lose nothing either: the answers are kept on this device.
    await context.setOffline(false);
    await expect(page.getByTestId('save-state')).toHaveText('All answers saved', { timeout: 20_000 });

    await page.getByRole('button', { name: 'Review & submit' }).click();
    await expect(page.getByText('3 answered')).toBeVisible();
    await page.getByRole('button', { name: 'Submit attempt' }).click();
    await page.waitForURL(/\/result$/);
    await expect(page.getByTestId('attempt-score')).toContainText('100 %');
    await expect(page.getByTestId('attempt-score')).toContainText('Passed');
    await expect(page.getByText('Mitochondria carry out respiration, which releases energy.')).toBeVisible();
    await expectNoSeriousAxeViolations(page);

    for (const body of bodies) expect(body).not.toMatch(SECRETS);
  });

  test('practice: immediate feedback, then a summary (F22)', async ({ page }) => {
    await signIn(page, ACME, DEMO.learner, `/learn/courses/${BIOLOGY_ID}/practice`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Practice');
    await page.getByRole('button', { name: 'Start practice' }).click();
    await page.waitForURL(/\/learn\/practice\/[0-9a-f-]{36}$/);
    const radio = page.getByRole('radio').first();
    const checkbox = page.getByRole('checkbox').first();
    if (await radio.isVisible()) await radio.check();
    else if (await checkbox.isVisible()) await checkbox.check();
    else await page.getByLabel('Your answer').fill('cell');
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Correct|Not quite/ })).toBeVisible();
    await expectNoSeriousAxeViolations(page);
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByTestId('practice-summary')).toBeVisible();
  });

  test('Studio: question bank, quiz builder and results (S-T05, S-T06, S-T10)', async ({ page }) => {
    await signIn(page, ACME, DEMO.acmeTutor, `/studio/courses/${BIOLOGY_ID}/questions`);
    await expect(
      page.getByRole('link', { name: 'Which organelle releases energy from food?' }),
    ).toBeVisible();
    await page.goto(school(ACME, `/studio/courses/${BIOLOGY_ID}/quizzes/${QUIZ_ID}`));
    await expect(page.getByTestId('quiz-total')).toHaveText('Total: 3 points · 3 questions');
    await expectNoSeriousAxeViolations(page);
    await page.goto(school(ACME, `/studio/courses/${BIOLOGY_ID}/results`));
    await expect(page.getByRole('row').filter({ hasText: 'Chanda Mwila' }).first()).toBeVisible();
    await page.goto(school(ACME, `/studio/courses/${BIOLOGY_ID}/results?tab=analytics&quizId=${QUIZ_ID}`));
    await expect(page.getByTestId('quiz-analytics')).toBeVisible();
  });
});
