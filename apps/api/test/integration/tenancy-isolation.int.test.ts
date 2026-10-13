import { randomBytes, randomUUID } from 'node:crypto';

import type { Client, QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionTenant } from '../../src/modules/tenancy';
import { startTestDatabase, type TestDatabase } from '../setup/postgres-container';
import { findRoleViolations, findTenancyViolations, tenantOwnedTables } from '../setup/tenancy-checks';

const INSUFFICIENT_PRIVILEGE = '42501'; // also raised for "new row violates row-level security policy"
const FOREIGN_KEY_VIOLATION = '23503';

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** Runs `fn` in one transaction with a transaction-local tenant context (as the app does). */
async function asTenant<T>(client: Client, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Outcome of an operation against another tenant's rows: affected rows, or denied outright. */
async function outcome(run: () => Promise<QueryResult>): Promise<'denied' | number> {
  try {
    const result = await run();
    return result.rows[0]?.count !== undefined ? Number(result.rows[0].count) : (result.rowCount ?? 0);
  } catch (error) {
    if ((error as { code?: string }).code === INSUFFICIENT_PRIVILEGE) return 'denied';
    throw error;
  }
}

/** One person (global account, D3) who is a member of both schools in the fixtures. */
let personId = '';
/** The fixture membership of each school, so dependent fixtures (and forgeries) can reference it. */
const membershipOf: Record<string, string> = {};
const fixtureHash = () => randomBytes(32);

/** How to create one row of each tenant-owned table. A new tenant table MUST be added here (T-ISO-05). */
const FIXTURES: Readonly<
  Record<string, { granted: boolean; insert: (c: Client, tenantId: string) => Promise<unknown> }>
> = {
  audit_log: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO audit_log (tenant_id, action, entity_type, entity_id) VALUES ($1, 'iso.fixture', 'fixture', $2)`,
        [tenantId, `marker-${tenantId}`],
      ),
  },
  outbox: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(`INSERT INTO outbox (tenant_id, topic, payload) VALUES ($1, 'iso.fixture', $2::jsonb)`, [
        tenantId,
        JSON.stringify({ marker: tenantId }),
      ]),
  },
  // Insertion order matters: memberships first, then rows that reference them.
  tenant_membership: {
    granted: true,
    insert: async (c, tenantId) => {
      const result = await c.query<{ id: string }>(
        `INSERT INTO tenant_membership (tenant_id, user_id, status) VALUES ($1, $2, 'ACTIVE')
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = EXCLUDED.status RETURNING id`,
        [tenantId, personId],
      );
      membershipOf[tenantId] ??= result.rows[0]!.id;
      return result;
    },
  },
  membership_role: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(`INSERT INTO membership_role (tenant_id, membership_id, role) VALUES ($1, $2, 'LEARNER')`, [
        tenantId,
        membershipOf[tenantId] ?? randomUUID(),
      ]),
  },
  session: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO session (tenant_id, user_id, membership_id, token_hash, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '1 day')`,
        [tenantId, personId, membershipOf[tenantId] ?? randomUUID(), fixtureHash()],
      ),
  },
  invitation: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO invitation (tenant_id, email, role, token_hash, expires_at)
         VALUES ($1, $2, 'INSTRUCTOR', $3, now() + interval '1 day')`,
        [tenantId, `invitee-${randomUUID().slice(0, 8)}@example.com`, fixtureHash()],
      ),
  },
  tenant_branding: {
    granted: false, // read-only for the runtime role until the branding editor (F39); provisioning writes it
    insert: (c, tenantId) =>
      c.query(`INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1, 'Forged School')`, [
        tenantId,
      ]),
  },
  tenant_branding_version: {
    granted: false,
    insert: (c, tenantId) =>
      c.query(`INSERT INTO tenant_branding_version (tenant_id, version, snapshot) VALUES ($1, 99, '{}')`, [
        tenantId,
      ]),
  },
  tenant_setting: {
    granted: false, // read-only for the runtime role until the settings screens; provisioning writes defaults
    insert: (c, tenantId) =>
      c.query(`INSERT INTO tenant_setting (tenant_id, key, value) VALUES ($1, 'isoFixture', '1')`, [
        tenantId,
      ]),
  },
  tenant_domain: {
    granted: false, // runtime code resolves hosts only through resolve_tenant()
    insert: (c, tenantId) =>
      c.query(`INSERT INTO tenant_domain (tenant_id, hostname) VALUES ($1, $2)`, [
        tenantId,
        `iso-${randomUUID().slice(0, 8)}.localhost`,
      ]),
  },
};

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

    // The fixture person: created as themselves (user_account's WITH CHECK is id = app.user_id).
    personId = randomUUID();
    await migrator.query('BEGIN');
    await migrator.query(`SELECT set_config('app.user_id', $1, true)`, [personId]);
    await migrator.query(
      `INSERT INTO user_account (id, email, display_name) VALUES ($1, $2, 'Fixture Person')`,
      [personId, `person-${personId.slice(0, 8)}@example.com`],
    );
    await migrator.query('COMMIT');

    for (const tenantId of [tenantA, tenantB]) {
      for (const fixture of Object.values(FIXTURES)) {
        if (fixture.granted) await asTenant(app, tenantId, () => fixture.insert(app, tenantId));
      }
    }
  });

  afterAll(async () => {
    await app?.end();
    await migrator?.end();
    await database?.stop();
  });

  it('T-ISO-03: every table follows the structural tenancy rules', async () => {
    expect(await findTenancyViolations(migrator)).toEqual([]);
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
      const result = await outcome(() => app.query(`SELECT count(*) FROM ${table}`));
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
      expect(await asB(`SELECT count(*) FROM ${table} WHERE tenant_id = $1`), `${table} read`).toSatisfy(
        isolated,
      );
      expect(
        await asB(`UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`),
        `${table} update`,
      ).toSatisfy(isolated);
      expect(await asB(`DELETE FROM ${table} WHERE tenant_id = $1`), `${table} delete`).toSatisfy(isolated);
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
        outcome(() => app.query(`SELECT count(*) FROM ${table}`)),
      );
      expect(count, table).toBeGreaterThan(0);
    }
  });

  it('T-ISO-05: FORCE RLS applies to the table owner (migrator) too', async () => {
    for (const table of await tenantOwnedTables(migrator)) {
      const count = await asTenant(migrator, tenantB, () =>
        outcome(() => migrator.query(`SELECT count(*) FROM ${table} WHERE tenant_id = $1`, [tenantA])),
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

  it('the app role reaches tenant_domain only through resolve_tenant()', async () => {
    expect(await sqlState(app.query('SELECT * FROM tenant_domain'))).toBe(INSUFFICIENT_PRIVILEGE);
    const known = await app.query(
      `SELECT tenant_id, status::text AS status, primary_host FROM resolve_tenant('ACME.localhost')`,
    );
    expect(known.rows).toEqual([{ tenant_id: tenantA, status: 'ACTIVE', primary_host: 'acme.localhost' }]);
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
