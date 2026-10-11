// `pnpm tenant:create -- --slug demo --name "Demo School" [--host demo.localhost] [--kind SCHOOL] [--status ACTIVE]`
// Provisions a school until the platform console exists (M9). Runs as the migrator role; local and CI use only.
import { parseArgs } from 'node:util';

import { Client } from 'pg';

import { ConfigError, loadMigratorEnv } from '../modules/platform';
import {
  PROVISIONABLE_STATUSES,
  type ProvisionableStatus,
  provisionTenant,
  TENANT_KINDS,
  type TenantKind,
} from '../modules/tenancy';

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${flag} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      host: { type: 'string' },
      kind: { type: 'string', default: 'SCHOOL' },
      status: { type: 'string', default: 'PROVISIONING' },
    },
    strict: true,
  });
  if (values.slug === undefined || values.name === undefined) {
    throw new Error(
      'Usage: pnpm tenant:create -- --slug <slug> --name "<name>" [--host <host>] [--kind SCHOOL] [--status PROVISIONING|ACTIVE]',
    );
  }

  const env = loadMigratorEnv();
  const client = new Client({
    connectionString: env.DATABASE_URL_MIGRATOR,
    application_name: 'studyhub-cli',
  });
  await client.connect();
  try {
    const result = await provisionTenant(client, {
      slug: values.slug,
      name: values.name,
      hostname: values.host ?? `${values.slug}.localhost`,
      kind: oneOf<TenantKind>(values.kind, TENANT_KINDS, 'kind'),
      status: oneOf<ProvisionableStatus>(values.status, PROVISIONABLE_STATUSES, 'status'),
    });
    console.log(
      result.outcome === 'created'
        ? `Created school "${values.slug}" (${result.tenantId}).`
        : `Not created: ${result.reason}.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof ConfigError ? error.message : String(error instanceof Error ? error.message : error),
  );
  process.exit(1);
});
