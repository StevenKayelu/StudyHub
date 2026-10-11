// `pnpm db:provision-roles`: (re)applies the role scripts in infra/postgres/init to the RUNNING local
// database. Needed once for a data volume created before M2, because PostgreSQL only runs init
// scripts when a volume is first created. Idempotent; runs as the container's superuser.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', '--env-file', '.env', '-f', 'infra/compose/docker-compose.dev.yml'];
const scripts = ['02-tenancy-roles.sql'];

for (const script of scripts) {
  const result = spawnSync(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      `psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/${script}`,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) {
    console.error(
      `Could not run docker: ${result.error.message}. Is Docker Desktop running and the database up (pnpm db:up)?`,
    );
    process.exit(2);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`Applied ${script}.`);
}
