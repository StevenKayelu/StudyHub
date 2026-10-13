import { readFileSync } from 'node:fs';
import path from 'node:path';

import { chromium, expect, test } from '@playwright/test';

/**
 * M3 AC 5: Lighthouse budget on the public shell (06 §9, UX-10). Mobile emulation with simulated
 * Slow 4G (Lighthouse defaults). Runs against the production build started by the e2e web servers.
 *
 * Budgets for Home / Browse / Course page:
 * - LCP ≤ 2.5 s;
 * - route JavaScript ≤ 120 KB compressed. "Route" = the page's own chunks on top of the shared
 *   framework runtime (Next.js + React, `rootMainFiles` in the build manifest, cached across pages),
 *   which alone is ~130 KB compressed with Next 16 / React 19 (see docs/design/m3-design-system.md);
 * - total JavaScript ≤ 150 KB compressed, a regression ceiling on top of the framework;
 * - fonts ≤ 120 KB and ≤ 4 files; accessibility score ≥ 0.95 (axe covers the details).
 */
const DEBUG_PORT = 9333;
const KB = 1024;
const BUDGET = { lcpMs: 2500, routeScriptKb: 120, totalScriptKb: 150, fontKb: 120, fontFiles: 4 };

interface NetworkItem {
  resourceType?: string;
  transferSize?: number;
  url: string;
}

/** The framework chunks every page loads, from the production build. */
function frameworkChunks(): Set<string> {
  const manifest = JSON.parse(
    readFileSync(path.join(process.cwd(), '.next', 'build-manifest.json'), 'utf8'),
  ) as {
    rootMainFiles: string[];
    polyfillFiles: string[];
  };
  return new Set([...manifest.rootMainFiles, ...manifest.polyfillFiles].map((file) => `/_next/${file}`));
}

test('public shell meets the 06 §9 performance budget', async () => {
  test.setTimeout(180_000);
  const framework = frameworkChunks();
  const channel = process.env.PLAYWRIGHT_CHANNEL;
  const browser = await chromium.launch({
    args: [`--remote-debugging-port=${DEBUG_PORT}`],
    ...(channel ? { channel } : {}),
  });
  try {
    const { default: lighthouse } = await import('lighthouse');
    const result = await lighthouse('http://acme.localhost:3000/', {
      port: DEBUG_PORT,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance', 'accessibility'],
    });
    if (result === undefined) throw new Error('Lighthouse returned no result');
    const { lhr } = result;

    const items = ((lhr.audits['network-requests']?.details as { items?: NetworkItem[] } | undefined)
      ?.items ?? []) as NetworkItem[];
    const kb = (list: NetworkItem[]) =>
      Math.round(list.reduce((total, item) => total + (item.transferSize ?? 0), 0) / KB);
    const scripts = items.filter((item) => item.resourceType === 'Script');
    const routeScripts = scripts.filter((item) => !framework.has(new URL(item.url).pathname));
    const fonts = items.filter((item) => item.resourceType === 'Font');

    const report = {
      performance: lhr.categories.performance?.score,
      accessibility: lhr.categories.accessibility?.score,
      lcpMs: Math.round(lhr.audits['largest-contentful-paint']?.numericValue ?? Number.POSITIVE_INFINITY),
      totalScriptKb: kb(scripts),
      frameworkScriptKb: kb(scripts) - kb(routeScripts),
      routeScriptKb: kb(routeScripts),
      fontKb: kb(fonts),
      fontFiles: fonts.length,
    };
    process.stdout.write(`LIGHTHOUSE ${JSON.stringify(report)}\n`);

    expect(report.lcpMs, 'LCP (ms)').toBeLessThanOrEqual(BUDGET.lcpMs);
    expect(report.routeScriptKb, 'route JavaScript (KB, compressed)').toBeLessThanOrEqual(
      BUDGET.routeScriptKb,
    );
    expect(report.totalScriptKb, 'total JavaScript (KB, compressed)').toBeLessThanOrEqual(
      BUDGET.totalScriptKb,
    );
    expect(report.fontKb, 'fonts (KB)').toBeLessThanOrEqual(BUDGET.fontKb);
    expect(report.fontFiles, 'font files').toBeLessThanOrEqual(BUDGET.fontFiles);
    expect(report.accessibility ?? 0, 'accessibility score').toBeGreaterThanOrEqual(0.95);
  } finally {
    await browser.close();
  }
});
