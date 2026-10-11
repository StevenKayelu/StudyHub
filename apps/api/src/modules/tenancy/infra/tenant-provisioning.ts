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
}

export type ProvisionResult =
  { outcome: 'created'; tenantId: string } | { outcome: 'exists'; reason: 'slug or hostname already taken' };

/**
 * Creates a school, its primary host and an audit entry in ONE transaction, inside the new school's
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
