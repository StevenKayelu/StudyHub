import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/cli/migrate';
import { API_ROOT, startTestDatabase, type TestDatabase } from '../setup/postgres-container';

/** PostgreSQL SQLSTATE for "insufficient_privilege". */
const INSUFFICIENT_PRIVILEGE = '42501';

async function sqlStateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('database migrations and roles (PostgreSQL 17)', () => {
  let database: TestDatabase;
  let migrator: Client;
  let app: Client;

  beforeAll(async () => {
    database = await startTestDatabase({ migrate: true });
    migrator = await database.connect(database.migratorUrl);
    app = await database.connect(database.appUrl);
  });

  afterAll(async () => {
    await app?.end();
    await migrator?.end();
    await database?.stop();
  });

  it('applies every migration, in order, to an empty database', async () => {
    const { rows } = await migrator.query<{ migration_name: string; finished: boolean }>(
      'SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name',
    );
    expect(rows).toEqual([
      { migration_name: '0001_init', finished: true },
      { migration_name: '0002_tenancy_kernel', finished: true },
      { migration_name: '0003_tenant_branding_settings', finished: true },
      { migration_name: '0004_identity_realms', finished: true },
      { migration_name: '0005_catalogue_authoring', finished: true },
      { migration_name: '0006_learning', finished: true },
      { migration_name: '0007_assessment', finished: true },
    ]);
  });

  it('closes new objects by default: tables created later grant nothing to the app role', async () => {
    await migrator.query('CREATE TABLE iso_default_closed (id int PRIMARY KEY)');
    try {
      expect(await sqlStateOf(app.query('SELECT * FROM iso_default_closed'))).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await migrator.query('DROP TABLE iso_default_closed');
    }
  });

  it('is idempotent when run again', async () => {
    await expect(runMigrations(database.migratorUrl, API_ROOT)).resolves.toBeUndefined();
  });

  it('installs the job-queue schema owned by the migrator', async () => {
    const { rows } = await migrator.query<{ owner: string }>(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'pgboss'",
    );
    expect(rows).toEqual([{ owner: 'studyhub_migrator' }]);
  });

  it('lets the app role read and write platform_setting', async () => {
    await app.query(`INSERT INTO platform_setting (key, value) VALUES ('maintenance.banner', '"off"')`);
    await app.query(`UPDATE platform_setting SET value = '"on"' WHERE key = 'maintenance.banner'`);
    const { rows } = await app.query<{ value: string }>(
      `SELECT value FROM platform_setting WHERE key = 'maintenance.banner'`,
    );
    expect(rows).toEqual([{ value: 'on' }]);
    await app.query(`DELETE FROM platform_setting WHERE key = 'maintenance.banner'`);
  });

  it('enforces the platform_setting key format at the database level', async () => {
    const state = await sqlStateOf(
      app.query(`INSERT INTO platform_setting (key, value) VALUES ('Bad Key', '1')`),
    );
    expect(state).toBe('23514'); // check_violation
  });

  it('denies the app role CREATE TABLE in the public schema', async () => {
    expect(await sqlStateOf(app.query('CREATE TABLE intruder (id int)'))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('denies the app role DROP TABLE and ALTER TABLE', async () => {
    expect(await sqlStateOf(app.query('DROP TABLE platform_setting'))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlStateOf(app.query('ALTER TABLE platform_setting ADD COLUMN extra int'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('denies the app role DDL in the job-queue schema', async () => {
    expect(await sqlStateOf(app.query('CREATE TABLE pgboss.intruder (id int)'))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('creates both roles without superuser, role-creation or RLS-bypass rights', async () => {
    const { rows } = await migrator.query<{
      rolname: string;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles
       WHERE rolname IN ('studyhub_app', 'studyhub_migrator') ORDER BY rolname`,
    );
    for (const role of rows) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolbypassrls: false,
      });
    }
    expect(rows.map((role) => role.rolname)).toEqual(['studyhub_app', 'studyhub_migrator']);
  });
});
