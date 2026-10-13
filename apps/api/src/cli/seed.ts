// `pnpm db:seed`: three demo schools for local development and e2e tests (idempotent).
// Runs as the migrator role. Never run against production.
import { Client } from 'pg';

import { ConfigError, loadMigratorEnv } from '../modules/platform';
import { provisionTenant, type ProvisionTenantInput, writeTenantProfile } from '../modules/tenancy';

/**
 * Acme keeps the Copperline default; Beta has its own accent, font preset and terminology, so the
 * theming runtime and terminology substitution are visible (and tested) side by side. Gamma is still
 * being set up.
 */
export const DEMO_TENANTS: readonly (ProvisionTenantInput & {
  branding: NonNullable<ProvisionTenantInput['branding']>;
})[] = [
  {
    slug: 'acme',
    name: 'Acme Academy',
    kind: 'SCHOOL',
    hostname: 'acme.localhost',
    status: 'ACTIVE',
    branding: { accentHex: null, fontPreset: 'COPPERLINE' },
  },
  {
    slug: 'beta',
    name: 'Beta College',
    kind: 'COLLEGE',
    hostname: 'beta.localhost',
    status: 'ACTIVE',
    branding: {
      accentHex: '#0b7285',
      fontPreset: 'HUMANIST',
      terminology: {
        instructor: { en: 'Lecturer' },
        instructors: { en: 'Lecturers' },
        course: { en: 'Module' },
        courses: { en: 'Modules' },
      },
    },
  },
  {
    // Not live yet: its site shows the "Coming soon" page (S-X08).
    slug: 'gamma',
    name: 'Gamma Tutors',
    kind: 'TUTORING_BUSINESS',
    hostname: 'gamma.localhost',
    status: 'PROVISIONING',
    branding: { accentHex: '#6d28d9', fontPreset: 'GEOMETRIC' },
  },
];

/**
 * Brings the branding of a demo school that already exists up to date. The school id is found the
 * way the runtime finds it (resolve_tenant, as the app role); the write runs as the migrator inside
 * that school's tenant context.
 */
async function refreshBranding(
  migrator: Client,
  appUrl: string | undefined,
  tenant: (typeof DEMO_TENANTS)[number],
): Promise<string> {
  if (appUrl === undefined) return 'already present (set DATABASE_URL_APP to refresh its branding)';
  const app = new Client({ connectionString: appUrl, application_name: 'studyhub-seed' });
  await app.connect();
  let tenantId: string | undefined;
  try {
    const { rows } = await app.query<{ tenant_id: string }>('SELECT tenant_id FROM resolve_tenant($1)', [
      tenant.hostname,
    ]);
    tenantId = rows[0]?.tenant_id;
  } finally {
    await app.end();
  }
  if (tenantId === undefined) return 'already present (host not active; branding unchanged)';

  await migrator.query('BEGIN');
  try {
    await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await writeTenantProfile(migrator, tenantId, tenant.name, tenant.branding);
    await migrator.query('COMMIT');
  } catch (error) {
    await migrator.query('ROLLBACK');
    throw error;
  }
  return 'already present (branding refreshed)';
}

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
      const outcome =
        result.outcome === 'created'
          ? 'created'
          : await refreshBranding(client, process.env.DATABASE_URL_APP, tenant);
      console.log(`${tenant.hostname}: ${outcome}`);
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
