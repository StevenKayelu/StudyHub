import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionTenant } from '../../src/modules/tenancy';
import { startTestDatabase, type TestDatabase } from '../setup/postgres-container';
import {
  findPlatformPolicyViolations,
  findRoleViolations,
  findTenancyViolations,
  PLATFORM_VISIBLE_TABLES,
  tenantOwnedTables,
} from '../setup/tenancy-checks';
import {
  asTenant,
  FIXTURES,
  FOREIGN_KEY_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  outcome,
  seedFixtures,
  sqlState,
} from '../setup/tenant-fixtures';

describe('tenant isolation in PostgreSQL (T-ISO-01..09, 15, 16)', () => {
  let database: TestDatabase;
  let migrator: Client;
  let app: Client;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    database = await startTestDatabase({ migrate: true });
    migrator = await database.connect(database.migratorUrl);
    app = await database.connect(database.appUrl);

    const first = await provisionTenant(migrator, {
      slug: 'acme',
      name: 'Acme Academy',
      kind: 'SCHOOL',
      hostname: 'acme.localhost',
      status: 'ACTIVE',
    });
    const second = await provisionTenant(migrator, {
      slug: 'beta',
      name: 'Beta College',
      kind: 'COLLEGE',
      hostname: 'beta.localhost',
      status: 'ACTIVE',
    });
    if (first.outcome !== 'created' || second.outcome !== 'created') throw new Error('provisioning failed');
    tenantA = first.tenantId;
    tenantB = second.tenantId;

    await seedFixtures(migrator, app, [tenantA, tenantB]);
  });

  afterAll(async () => {
    await app?.end();
    await migrator?.end();
    await database?.stop();
  });

  it('T-ISO-03: every table follows the structural tenancy rules', async () => {
    expect(await findTenancyViolations(migrator)).toEqual([]);
  });

  it('T-ISO-21: console-realm policies only on the ADR-0020 allowlist, with no personal columns', async () => {
    expect(await findPlatformPolicyViolations(migrator)).toEqual([]);
  });

  it('T-ISO-21: the console realm sees school metadata, and nothing of any other school table', async () => {
    const asConsole = async (sql: string) => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.realm', 'platform', true)`);
        return await outcome(() => app.query(sql));
      } finally {
        await app.query('ROLLBACK');
      }
    };
    expect(await asConsole('SELECT count(*) FROM tenant')).toBeGreaterThanOrEqual(2);
    expect(await asConsole('SELECT count(*) FROM tenant_usage_daily')).toBeGreaterThanOrEqual(2);
    for (const table of await tenantOwnedTables(migrator)) {
      if (PLATFORM_VISIBLE_TABLES.has(table)) continue;
      expect(await asConsole(`SELECT count(*) FROM "${table}"`), `${table} in the console realm`).toSatisfy(
        (value: unknown) => value === 0 || value === 'denied',
      );
    }
    // School members and accounts stay invisible too.
    expect(await asConsole('SELECT count(*) FROM user_account')).toBe(0);
  });

  it('T-ISO-21: a school cannot create schools, add hosts, change its plan or forge statements', async () => {
    expect(
      await sqlState(
        asTenant(app, tenantB, () =>
          app.query(`UPDATE tenant SET slug = 'beta-new' WHERE id = $1`, [tenantB]),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(asTenant(app, tenantB, () => FIXTURES.tenant_domain!.insert(app, tenantB)))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await sqlState(asTenant(app, tenantB, () => FIXTURES.platform_statement!.insert(app, tenantB))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlState(
        asTenant(app, tenantB, () =>
          app.query(
            `INSERT INTO tenant_feature (tenant_id, feature_key, platform_override) VALUES ($1, 'whiteLabel', 'GRANT')`,
            [tenantB],
          ),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('T-ISO-03 (meta): the check catches a tenant table without RLS', async () => {
    await migrator.query('CREATE TABLE iso_unprotected (id int PRIMARY KEY, tenant_id uuid NOT NULL)');
    try {
      const violations = await findTenancyViolations(migrator);
      expect(violations).toEqual(
        expect.arrayContaining([
          'iso_unprotected: row-level security is not enabled',
          'iso_unprotected: row-level security is not forced',
        ]),
      );
    } finally {
      await migrator.query('DROP TABLE iso_unprotected');
    }
  });

  it('T-ISO-01/02: no login role can bypass RLS; the app role owns nothing and has DML only', async () => {
    expect(await findRoleViolations(migrator)).toEqual([]);
  });

  it('T-ISO-04: with no tenant context every tenant table is empty and writes fail', async () => {
    for (const table of [...(await tenantOwnedTables(migrator)), 'tenant']) {
      const result = await outcome(() => app.query(`SELECT count(*) FROM "${table}"`));
      expect([0, 'denied'], `${table} without context`).toContain(result);
    }
    expect(await sqlState(FIXTURES.audit_log!.insert(app, tenantA))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('T-ISO-05: every tenant table has a fixture (new tables must join this matrix)', async () => {
    const tables = await tenantOwnedTables(migrator);
    expect(tables.filter((table) => !(table in FIXTURES))).toEqual([]);
  });

  it('T-ISO-05: as tenant B, tenant A rows cannot be read, changed, deleted or forged', async () => {
    const isolated = (value: unknown) => value === 0 || value === 'denied';
    for (const table of await tenantOwnedTables(migrator)) {
      const fixture = FIXTURES[table]!;
      // Each operation in its own transaction: a denied statement aborts the transaction it runs in.
      const asB = (sql: string) => outcome(() => asTenant(app, tenantB, () => app.query(sql, [tenantA])));
      expect(await asB(`SELECT count(*) FROM "${table}" WHERE tenant_id = $1`), `${table} read`).toSatisfy(
        isolated,
      );
      expect(
        await asB(`UPDATE "${table}" SET tenant_id = tenant_id WHERE tenant_id = $1`),
        `${table} update`,
      ).toSatisfy(isolated);
      expect(await asB(`DELETE FROM "${table}" WHERE tenant_id = $1`), `${table} delete`).toSatisfy(isolated);
      // Forging: inserting a row that belongs to A while acting as B.
      expect(
        await sqlState(asTenant(app, tenantB, () => fixture.insert(app, tenantA))),
        `${table} forged insert`,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('T-ISO-05 (controls): tenant A sees its own rows, so the matrix is not vacuous', async () => {
    for (const [table, fixture] of Object.entries(FIXTURES)) {
      if (!fixture.granted) continue;
      const count = await asTenant(app, tenantA, () =>
        outcome(() => app.query(`SELECT count(*) FROM "${table}"`)),
      );
      expect(count, table).toBeGreaterThan(0);
    }
  });

  it('T-ISO-05: FORCE RLS applies to the table owner (migrator) too', async () => {
    for (const table of await tenantOwnedTables(migrator)) {
      const count = await asTenant(migrator, tenantB, () =>
        outcome(() => migrator.query(`SELECT count(*) FROM "${table}" WHERE tenant_id = $1`, [tenantA])),
      );
      expect(count, table).toBe(0);
    }
  });

  it('the tenant row itself is visible only inside its own context', async () => {
    const asB = await asTenant(app, tenantB, () => app.query(`SELECT id FROM tenant`));
    expect(asB.rows).toEqual([{ id: tenantB }]);
    const none = await app.query(`SELECT id FROM tenant`);
    expect(none.rows).toEqual([]);
  });

  it('a school sees only its own hosts; host resolution goes through resolve_tenant() (M9)', async () => {
    expect((await app.query('SELECT * FROM tenant_domain')).rows).toEqual([]);
    const own = await asTenant(app, tenantB, () => app.query('SELECT hostname FROM tenant_domain'));
    expect(own.rows).toEqual([{ hostname: 'beta.localhost' }]);
    const known = await app.query(
      `SELECT tenant_id, status::text AS status, primary_host, is_redirect FROM resolve_tenant('ACME.localhost')`,
    );
    expect(known.rows).toEqual([
      { tenant_id: tenantA, status: 'ACTIVE', primary_host: 'acme.localhost', is_redirect: false },
    ]);
    const unknown = await app.query(`SELECT * FROM resolve_tenant('nope.localhost')`);
    expect(unknown.rows).toEqual([]);
  });

  it('claim_due_outbox() returns only (id, tenant_id) and never row content', async () => {
    const claimed = await app.query(`SELECT * FROM claim_due_outbox(10)`);
    expect(claimed.fields.map((field) => field.name)).toEqual(['id', 'tenant_id']);
    expect(new Set(claimed.rows.map((row: { tenant_id: string }) => row.tenant_id))).toEqual(
      new Set([tenantA, tenantB]),
    );
  });

  describe('T-ISO-06/07: composite tenant keys', () => {
    beforeAll(async () => {
      await migrator.query(`
        CREATE TABLE iso_parent (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), slug text NOT NULL,
                                 UNIQUE (tenant_id, id), UNIQUE (tenant_id, slug));
        CREATE TABLE iso_child (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, parent_id uuid NOT NULL,
                                FOREIGN KEY (tenant_id, parent_id) REFERENCES iso_parent (tenant_id, id));
        CREATE TABLE iso_child_naive (id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
                                      parent_id uuid NOT NULL REFERENCES iso_parent (id));
        SELECT tenancy_apply_isolation('iso_parent');
        SELECT tenancy_apply_isolation('iso_child');
        SELECT tenancy_apply_isolation('iso_child_naive');
        GRANT SELECT, INSERT ON iso_parent, iso_child, iso_child_naive TO studyhub_app;`);
    });

    afterAll(async () => {
      await migrator.query('DROP TABLE iso_child_naive, iso_child, iso_parent');
    });

    it('rejects a child in tenant B that references tenant A parent (composite FK)', async () => {
      const parentA = randomUUID();
      await asTenant(app, tenantA, () =>
        app.query(`INSERT INTO iso_parent (id, tenant_id, slug) VALUES ($1, $2, 'biology')`, [
          parentA,
          tenantA,
        ]),
      );
      const state = await sqlState(
        asTenant(app, tenantB, () =>
          app.query(`INSERT INTO iso_child (id, tenant_id, parent_id) VALUES ($1, $2, $3)`, [
            randomUUID(),
            tenantB,
            parentA,
          ]),
        ),
      );
      expect(state).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('documents why: a single-column FK is checked without RLS and would accept it', async () => {
      const parentA = randomUUID();
      await asTenant(app, tenantA, () =>
        app.query(`INSERT INTO iso_parent (id, tenant_id, slug) VALUES ($1, $2, 'chemistry')`, [
          parentA,
          tenantA,
        ]),
      );
      await expect(
        asTenant(app, tenantB, () =>
          app.query(`INSERT INTO iso_child_naive (id, tenant_id, parent_id) VALUES ($1, $2, $3)`, [
            randomUUID(),
            tenantB,
            parentA,
          ]),
        ),
      ).resolves.toBeDefined();
    });

    it('allows the same natural key in two tenants (tenant-scoped unique keys)', async () => {
      await asTenant(app, tenantA, () =>
        app.query(`INSERT INTO iso_parent (id, tenant_id, slug) VALUES ($1, $2, 'physics')`, [
          randomUUID(),
          tenantA,
        ]),
      );
      await expect(
        asTenant(app, tenantB, () =>
          app.query(`INSERT INTO iso_parent (id, tenant_id, slug) VALUES ($1, $2, 'physics')`, [
            randomUUID(),
            tenantB,
          ]),
        ),
      ).resolves.toBeDefined();
    });
  });

  it('T-ISO-08 (meta): a view without security_invoker is flagged', async () => {
    await migrator.query('CREATE VIEW iso_view AS SELECT id, tenant_id FROM audit_log');
    try {
      expect(await findTenancyViolations(migrator)).toContain('iso_view: view is not security_invoker');
    } finally {
      await migrator.query('DROP VIEW iso_view');
    }
  });

  it('T-ISO-09 (meta): an uninventoried SECURITY DEFINER function is flagged', async () => {
    await migrator.query(
      `CREATE FUNCTION iso_rogue() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM audit_log'`,
    );
    try {
      const violations = await findTenancyViolations(migrator);
      expect(violations).toEqual(
        expect.arrayContaining([
          'iso_rogue: SECURITY DEFINER function not on the inventory',
          'iso_rogue: search_path is not fixed',
        ]),
      );
    } finally {
      await migrator.query('DROP FUNCTION iso_rogue()');
    }
  });

  it('T-ISO-15: a pooled connection never carries tenant context past its transaction', async () => {
    const inside = await asTenant(app, tenantA, () => app.query('SELECT count(*)::int AS n FROM audit_log'));
    expect(inside.rows[0].n).toBeGreaterThan(0);
    const after = await app.query(
      `SELECT count(*)::int AS n, coalesce(current_setting('app.tenant_id', true), '') AS ctx FROM audit_log`,
    );
    expect(after.rows[0]).toEqual({ n: 0, ctx: '' });
  });

  it('T-ISO-16: planner statistics of tenant tables are hidden from the app role', async () => {
    await migrator.query(
      `INSERT INTO platform_setting (key, value) VALUES ('iso.stats', '1') ON CONFLICT DO NOTHING`,
    );
    await migrator.query('ANALYZE audit_log; ANALYZE outbox; ANALYZE platform_setting');
    const tenantStats = await app.query(
      `SELECT count(*)::int AS n FROM pg_stats WHERE schemaname = 'public' AND tablename IN ('audit_log', 'outbox', 'tenant', 'tenant_domain')`,
    );
    expect(tenantStats.rows[0].n).toBe(0);
    const control = await app.query(
      `SELECT count(*)::int AS n FROM pg_stats WHERE schemaname = 'public' AND tablename = 'platform_setting'`,
    );
    expect(control.rows[0].n).toBeGreaterThan(0);
  });
});
