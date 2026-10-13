import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

interface IndexEntry {
  id: string;
  type: string;
  parameters?: { console?: boolean };
}

const index = JSON.parse(
  readFileSync(fileURLToPath(new URL('../storybook-static/index.json', import.meta.url)), 'utf8'),
) as { entries: Record<string, IndexEntry> };
const stories = Object.values(index.entries)
  .filter((entry) => entry.type === 'story')
  .map((entry) => entry.id);

/** 07 M3 AC 1: the default theme and two school themes; dark mode once for the default. */
const THEME_RUNS = [
  { theme: 'copperline', scheme: 'light' },
  { theme: 'school-teal', scheme: 'light' },
  { theme: 'school-violet', scheme: 'light' },
  { theme: 'copperline', scheme: 'dark' },
] as const;

/** 07 M3 AC 2 / UX-08: compact, compact-large, medium, expanded, wide. */
const WIDTHS = [320, 375, 768, 1024, 1440] as const;

async function openStory(page: Page, id: string, theme: string, scheme: string): Promise<void> {
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme};scheme:${scheme}`);
  await page.locator('#storybook-root').waitFor({ state: 'attached' });
  await expect(page.locator('html')).toHaveAttribute('data-applied-theme', /.+/);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

test.describe('axe: 0 serious or critical violations (UX-06)', () => {
  for (const id of stories) {
    for (const { theme, scheme } of THEME_RUNS) {
      test(`${id} · ${theme} · ${scheme}`, async ({ page }) => {
        await openStory(page, id, theme, scheme);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        const blocking = results.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .map((violation) => ({
            rule: violation.id,
            impact: violation.impact,
            nodes: violation.nodes.map((node) => `${node.target.join(' ')}: ${node.failureSummary ?? ''}`),
          }));
        expect(blocking).toEqual([]);
      });
    }
  }
});

test.describe('visual regression at 5 widths (UX-08)', () => {
  for (const id of stories) {
    for (const width of WIDTHS) {
      test(`${id} @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openStory(page, id, 'copperline', 'light');
        // No horizontal scroll at any width (UX-08).
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
        await expect(page).toHaveScreenshot(`${id}-${width}.png`, { fullPage: true });
      });
    }
  }
});
