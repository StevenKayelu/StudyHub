import { randomUUID } from 'node:crypto';

import type { ClientBase } from 'pg';

import { normalizeHost, slugProblem } from '../domain/host';

export const TENANT_KINDS = [
  'SCHOOL',
  'COLLEGE',
  'UNIVERSITY',
  'TUTORING_BUSINESS',
  'INDEPENDENT_TUTOR',
  'MARKETPLACE',
  'OTHER',
] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

export const PROVISIONABLE_STATUSES = ['PROVISIONING', 'ACTIVE'] as const;
export type ProvisionableStatus = (typeof PROVISIONABLE_STATUSES)[number];

export interface ProvisionTenantInput {
  slug: string;
  name: string;
  kind: TenantKind;
  hostname: string;
  status: ProvisionableStatus;
  /** Initial branding; defaults to Copperline with the school name. */
  branding?: TenantBrandingInput;
}

/** Branding written at provisioning (and by the demo seed). The editor (F39) replaces this later. */
export interface TenantBrandingInput {
  /** Lowercase #rrggbb that the theme compiler accepts, or null for the default copper. */
  accentHex: string | null;
  fontPreset: 'COPPERLINE' | 'HUMANIST' | 'GEOMETRIC';
  terminology?: Record<string, Record<string, string>>;
}

const DEFAULT_SETTINGS: Readonly<Record<string, unknown>> = {
  defaultLocale: 'en',
  enabledLocales: ['en'],
  timeZone: 'Africa/Lusaka',
};

/**
 * Publishes branding (as version 1, or the next version) and fills missing default settings, in the
 * caller's transaction. The caller must have set app.tenant_id to `tenantId` (FORCE RLS).
 */
export async function writeTenantProfile(
  client: ClientBase,
  tenantId: string,
  displayName: string,
  branding: TenantBrandingInput,
): Promise<void> {
  const accent = branding.accentHex === null ? null : branding.accentHex.toLowerCase();
  await client.query(
    `INSERT INTO tenant_branding (tenant_id, display_name, accent_hex, font_preset, terminology, status, published_at)
     VALUES ($1, $2, $3, $4::"FontPreset", $5::jsonb, 'PUBLISHED', now())
     ON CONFLICT (tenant_id) DO UPDATE
        SET display_name = EXCLUDED.display_name, accent_hex = EXCLUDED.accent_hex,
            font_preset = EXCLUDED.font_preset, terminology = EXCLUDED.terminology,
            status = 'PUBLISHED', published_at = now(), updated_at = now(),
            version = tenant_branding.version + 1
      WHERE (tenant_branding.display_name, tenant_branding.accent_hex, tenant_branding.font_preset,
             tenant_branding.terminology)
            IS DISTINCT FROM (EXCLUDED.display_name, EXCLUDED.accent_hex, EXCLUDED.font_preset,
             EXCLUDED.terminology)`,
    [tenantId, displayName, accent, branding.fontPreset, JSON.stringify(branding.terminology ?? {})],
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await client.query(
      `INSERT INTO tenant_setting (tenant_id, key, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [tenantId, key, JSON.stringify(value)],
    );
  }
}

export type ProvisionResult =
  { outcome: 'created'; tenantId: string } | { outcome: 'exists'; reason: 'slug or hostname already taken' };

/**
 * Creates a school, its primary host, default branding and settings, and an audit entry in ONE transaction, inside the new school's
 * tenant context (FORCE RLS applies to the caller too, so every row must belong to that tenant).
 * Used by the provisioning CLIs, which run as the migrator, until the platform console exists (M9).
 * Idempotent: an existing slug or hostname is reported, never overwritten.
 */
export async function provisionTenant(
  client: ClientBase,
  input: ProvisionTenantInput,
): Promise<ProvisionResult> {
  const problem = slugProblem(input.slug);
  if (problem !== null) throw new Error(`Invalid slug "${input.slug}": ${problem}`);
  const hostname = normalizeHost(input.hostname);
  if (hostname === null) throw new Error(`Invalid hostname "${input.hostname}"`);
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) throw new Error('Name must be 2-120 characters');

  const tenantId = randomUUID();
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    await client.query(
      `INSERT INTO tenant (id, slug, name, kind, status) VALUES ($1, $2, $3, $4::"TenantKind", $5::"TenantStatus")`,
      [tenantId, input.slug, name, input.kind, input.status],
    );
    await client.query(
      `INSERT INTO tenant_domain (tenant_id, hostname, type, status, is_primary, verified_at)
       VALUES ($1, $2, 'SUBDOMAIN', 'ACTIVE', true, now())`,
      [tenantId, hostname],
    );
    await writeTenantProfile(
      client,
      tenantId,
      name,
      input.branding ?? { accentHex: null, fontPreset: 'COPPERLINE' },
    );
    await client.query(
      `INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, after)
       VALUES ($1::uuid, 'tenant.created', 'tenant', $2::text, $3::jsonb)`,
      [
        tenantId,
        tenantId,
        JSON.stringify({ slug: input.slug, name, kind: input.kind, hostname, status: input.status }),
      ],
    );
    await client.query('COMMIT');
    return { outcome: 'created', tenantId };
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') {
      return { outcome: 'exists', reason: 'slug or hostname already taken' };
    }
    throw error;
  }
}
