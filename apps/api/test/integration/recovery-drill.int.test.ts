import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestDatabase } from '../setup/postgres-container';
import { restoreDisposableBackup } from '../setup/recovery-drill';
import { type Harness, startHarness } from '../setup/school-harness';
import { findRoleViolations, findTenancyViolations } from '../setup/tenancy-checks';
import { asTenant, seedFixtures } from '../setup/tenant-fixtures';

/** Full database logical recovery; object versions, provider state and PITR are separate gates. */
describe('disposable full-database recovery (M10)', () => {
  let h: Harness;
  let restored: TestDatabase | undefined;
  const clients: Client[] = [];
  beforeAll(async () => {
    h = await startHarness();
    const app = await h.database.connect(h.database.appUrl);
    clients.push(app);
    await seedFixtures(h.migrator, app, [h.tenants.acme, h.tenants.beta]);
  });
  afterAll(async () => {
    for (const client of clients) await client.end();
    await restored?.stop();
    await h?.close();
  });

  async function snapshot(client: Client): Promise<Record<string, unknown>> {
    const { rows } = await client.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );
    const result: Record<string, unknown> = {};
    for (const { name } of rows) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('Unexpected table name');
      result[name] = (
        await client.query(
          `SELECT count(*)::int AS count, md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash FROM "${name}" t`,
        )
      ).rows[0];
    }
    return result;
  }

  it('recovers every public table and forced RLS into a fresh target, with measured local RTO', async () => {
    const source = await h.database.connect(h.database.superuserUrl);
    clients.push(source);
    const before = await snapshot(source);
    const start = performance.now();
    const recovery = await restoreDisposableBackup(h.database);
    restored = recovery.restored;
    const target = await restored.connect(restored.superuserUrl);
    clients.push(target);
    expect(await snapshot(target)).toEqual(before);
    expect(await findTenancyViolations(target)).toEqual([]);
    expect(await findRoleViolations(target)).toEqual([]);
    // A recovered runtime login still sees only its school, not both schools restored by pg_dump.
    const app = await restored.connect(restored.appUrl);
    clients.push(app);
    expect((await app.query('SELECT id FROM course')).rowCount).toBe(0);
    await asTenant(app, h.tenants.acme, async () => {
      const rows = await app.query<{ tenant_id: string }>('SELECT tenant_id FROM course');
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((row) => row.tenant_id === h.tenants.acme)).toBe(true);
    });
    // Later source changes do not silently appear in the recovery snapshot.
    await source.query('BEGIN');
    await source.query("SELECT set_config('app.realm', 'platform', true)");
    await source.query(`UPDATE tenant SET name='Changed after backup' WHERE id=$1`, [h.tenants.acme]);
    await source.query('COMMIT');
    expect((await target.query('SELECT name FROM tenant WHERE id=$1', [h.tenants.acme])).rows[0].name).toBe(
      'Acme Academy',
    );
    const validatedRtoMs = performance.now() - start;
    mkdirSync('test-results/recovery', { recursive: true });
    writeFileSync(
      'test-results/recovery/latest.json',
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          backupMs: recovery.backupMs,
          restoreMs: recovery.restoreMs,
          validatedRtoMs,
          tables: Object.keys(before).length,
          scope: 'Disposable full logical database recovery; excludes objects, external providers and PITR',
        },
        null,
        2,
      ),
    );
    expect(validatedRtoMs).toBeLessThan(4 * 3600_000);
  }, 180_000);
});
