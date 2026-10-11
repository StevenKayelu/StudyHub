// `pnpm db:seed`: two demo schools for local development and e2e tests (idempotent).
// Runs as the migrator role. Never run against production.
import { Client } from 'pg';

import { ConfigError, loadMigratorEnv } from '../modules/platform';
import { provisionTenant, type ProvisionTenantInput } from '../modules/tenancy';

export const DEMO_TENANTS: readonly ProvisionTenantInput[] = [
  { slug: 'acme', name: 'Acme Academy', kind: 'SCHOOL', hostname: 'acme.localhost', status: 'ACTIVE' },
  { slug: 'beta', name: 'Beta College', kind: 'COLLEGE', hostname: 'beta.localhost', status: 'ACTIVE' },
];

async function main(): Promise<void> {
  const env = loadMigratorEnv();
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed demo schools in production.');

  const client = new Client({
    connectionString: env.DATABASE_URL_MIGRATOR,
    application_name: 'studyhub-seed',
  });
  await client.connect();
  try {
    for (const tenant of DEMO_TENANTS) {
      const result = await provisionTenant(client, tenant);
      console.log(`${tenant.hostname}: ${result.outcome === 'created' ? 'created' : 'already present'}`);
    }
  } finally {
    await client.end();
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : `Seed failed: ${String(error)}`);
    process.exit(1);
  });
}
