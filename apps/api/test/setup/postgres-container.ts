import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

import { runMigrations } from '../../src/cli/migrate';

export const POSTGRES_IMAGE = 'postgres:17';

/** Vitest runs from apps/api (pnpm --filter / turbo). */
export const API_ROOT = process.cwd();

/** The same role script local development uses (infra/postgres/init/01-roles.sql). */
const ROLES_SQL = path.resolve(API_ROOT, '..', '..', 'infra', 'postgres', 'init', '01-roles.sql');

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  superuserUrl: string;
  migratorUrl: string;
  appUrl: string;
  /** Opens a pg client for the given connection URL (caller must end it). */
  connect(url: string): Promise<Client>;
  stop(): Promise<void>;
}

/** Throwaway per-run password; never written anywhere. */
const randomPassword = (): string => randomBytes(18).toString('hex');

/**
 * Starts a fresh PostgreSQL 17 container initialised with the real role script and, by default,
 * migrated exactly as `pnpm db:migrate` does.
 */
export async function startTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const passwords = { superuser: randomPassword(), migrator: randomPassword(), app: randomPassword() };

  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('studyhub')
    .withUsername('postgres')
    .withPassword(passwords.superuser)
    .withEnvironment({
      STUDYHUB_MIGRATOR_PASSWORD: passwords.migrator,
      STUDYHUB_APP_PASSWORD: passwords.app,
    })
    .withCopyFilesToContainer([{ source: ROLES_SQL, target: '/docker-entrypoint-initdb.d/01-roles.sql' }])
    .start();

  const urlFor = (user: string, password: string): string =>
    `postgresql://${user}:${password}@${container.getHost()}:${container.getPort()}/studyhub`;

  const database: TestDatabase = {
    container,
    superuserUrl: urlFor('postgres', passwords.superuser),
    migratorUrl: urlFor('studyhub_migrator', passwords.migrator),
    appUrl: urlFor('studyhub_app', passwords.app),
    async connect(url) {
      const client = new Client({ connectionString: url });
      await client.connect();
      return client;
    },
    async stop() {
      await container.stop();
    },
  };

  if (options.migrate ?? true) {
    await runMigrations(database.migratorUrl, API_ROOT);
  }
  return database;
}
