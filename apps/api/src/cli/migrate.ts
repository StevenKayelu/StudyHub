// `pnpm db:migrate`: applies Prisma migrations and installs the job-queue schema, as the migrator role.
// Never runs implicitly at application start (ADR-0003).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { ConfigError, installJobSchema, loadMigratorEnv } from '../modules/platform';

/**
 * Runs `prisma migrate deploy` against the given database, then installs pg-boss.
 * @param apiRoot the apps/api directory (holds prisma.config.ts and prisma/migrations)
 */
export async function runMigrations(migratorUrl: string, apiRoot: string): Promise<void> {
  const prismaCli = createRequire(path.join(apiRoot, 'package.json')).resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL_MIGRATOR: migratorUrl },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  await installJobSchema(migratorUrl);
}

async function main(): Promise<void> {
  const env = loadMigratorEnv();
  console.log('Applying database migrations as studyhub_migrator…');
  await runMigrations(env.DATABASE_URL_MIGRATOR, path.resolve(__dirname, '..', '..'));
  console.log('Database migrations and job-queue schema are up to date.');
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : `Migration failed: ${String(error)}`);
    process.exit(1);
  });
}
