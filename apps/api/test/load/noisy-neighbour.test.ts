import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { get } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Harness, SCHOOLS, startHarness } from '../setup/school-harness';

/** Real TCP + PostgreSQL smoke check of school request-budget isolation. This does not establish
 * export/worker fairness, authenticated write capacity, 50-school scale or launch-infrastructure SLOs.
 */
describe('local noisy-neighbour HTTP smoke', () => {
  let h: Harness;
  let origin: string;
  beforeAll(async () => {
    h = await startHarness({ env: { API_RATE_TENANT_PER_MINUTE: '100' } });
    await h.app.listen(0, '127.0.0.1');
    origin = await h.app.getUrl();
  });
  afterAll(async () => {
    await h?.close();
  });
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;

  async function read(host: string): Promise<{ status: number; ms: number }> {
    const start = performance.now();
    // Node fetch canonicalizes Host; use the actual HTTP client so host-based school routing is
    // exercised over TCP rather than accidentally benchmarking the neutral unknown-host 404.
    return new Promise((resolve, reject) => {
      const request = get(`${origin}/api/v1/courses`, { headers: { host } }, (response) => {
        response.resume();
        response.once('end', () =>
          resolve({ status: response.statusCode ?? 0, ms: performance.now() - start }),
        );
        response.once('error', reject);
      });
      request.once('error', reject);
      request.setTimeout(10_000, () => request.destroy(new Error('HTTP load request timed out')));
    });
  }

  it('throttles the noisy school while another school keeps successful reads within 300 ms p95', async () => {
    const baseline = [];
    for (let i = 0; i < 20; i += 1) baseline.push(await read(SCHOOLS.beta));
    const other: Awaited<ReturnType<typeof read>>[] = [];
    const noisy: Awaited<ReturnType<typeof read>>[] = [];
    await Promise.all([
      ...Array.from({ length: 10 }, async () => {
        for (let i = 0; i < 30; i += 1) noisy.push(await read(SCHOOLS.acme));
      }),
      (async () => {
        for (let i = 0; i < 60; i += 1) other.push(await read(SCHOOLS.beta));
      })(),
    ]);
    const report = {
      measuredAt: new Date().toISOString(),
      scope: 'Two-school read-only TCP rate-limit smoke; 10 noisy clients',
      baselineReads: baseline.length,
      baselineP95Ms: p95(baseline.map((r) => r.ms)),
      isolatedReads: other.length,
      isolatedP95Ms: p95(other.map((r) => r.ms)),
      noisyRequests: noisy.length,
      noisyThrottled: noisy.filter((r) => r.status === 429).length,
      unexpectedStatuses: [...baseline, ...other].filter((r) => r.status !== 200).map((r) => r.status),
    };
    mkdirSync('test-results/load', { recursive: true });
    writeFileSync('test-results/load/latest.json', JSON.stringify(report, null, 2));
    expect(report.unexpectedStatuses).toEqual([]);
    expect(noisy.every((r) => r.status === 200 || r.status === 429)).toBe(true);
    expect(report.noisyThrottled).toBe(200);
    expect(report.isolatedP95Ms).toBeLessThanOrEqual(300);
  });
});
