import { createHash } from 'node:crypto';

import { richTextSchema, richTextToPlain } from '@studyhub/contracts';
import { z } from 'zod';

import { Prisma, type PrismaClient } from '../../../generated/prisma/client';
import { AppError, currentContext, runInPlatformTenantTx, type TenantTx } from '../../platform';

/** Explicit first recovery scope. Never infer writable fields/tables from an uploaded archive.
 * No inserts, deletes, FK rewrites, identities, credentials, money, access or permission changes.
 * This library has no HTTP/CLI write entrypoint; production owner review/reauth remains a launch gate.
 */
const tables = ['course', 'section', 'lesson'] as const;
type Table = (typeof tables)[number];
type Row = Record<string, unknown>;
const identity = z.object({ id: z.uuid(), tenant_id: z.uuid() });
const title = z.string().trim().min(1).max(120);
const contentSchemas = {
  course: z.object({
    title,
    subtitle: z.string().max(200).nullable(),
    description_json: richTextSchema.nullable(),
  }),
  section: z.object({ title }),
  lesson: z.object({ title }),
};
const SCOPE = 'existing-course-content-v1';

export interface SchoolRecoveryPlan {
  scope: typeof SCOPE;
  tenantId: string;
  reviewDigest: string;
  changes: Array<{ table: Table; id: string; before: Row; after: Row }>;
  blockers: Array<{ table: Table; id: string; reason: string }>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const recoveryDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

function readArchive(tenantId: string, entries: ReadonlyMap<string, Buffer>): Record<Table, Row[]> {
  z.uuid().parse(tenantId);
  const read = (name: string): unknown => {
    const data = entries.get(name);
    if (!data || data.length > 16 * 1024 * 1024)
      throw new Error(`Missing or oversized recovery entry: ${name}`);
    return JSON.parse(data.toString('utf8')) as unknown;
  };
  if (z.object({ id: z.uuid() }).parse(read('data/tenant.json')).id !== tenantId)
    throw new Error('Recovery school mismatch');
  const result = {} as Record<Table, Row[]>;
  for (const table of tables) {
    const rows = z
      .array(z.record(z.string(), z.unknown()))
      .max(10000)
      .parse(read(`data/${table}.json`));
    const seen = new Set<string>();
    for (const row of rows) {
      const ids = identity.parse(row);
      if (ids.tenant_id !== tenantId || seen.has(ids.id))
        throw new Error('Foreign or duplicate recovery row');
      seen.add(ids.id);
      contentSchemas[table].parse(row);
      if (table !== 'course') z.uuid().parse(row.course_id);
      if (table === 'lesson') {
        z.uuid().parse(row.section_id);
        z.enum(['TEXT', 'VIDEO', 'FILE', 'QUIZ']).parse(row.type);
        if (row.type === 'TEXT') richTextSchema.nullable().parse(row.content_json);
      }
    }
    result[table] = rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return result;
}

function fields(table: Table, row: Row, fromArchive: boolean): Row {
  // Validate the replacement, not the damaged live value: recovery must also repair invalid JSON
  // or derived search text. Current values are returned only as escaped review data, never rendered.
  const values: Row = fromArchive
    ? contentSchemas[table].parse(row)
    : Object.fromEntries(Object.keys(contentSchemas[table].shape).map((key) => [key, row[key]]));
  if (table === 'course')
    values.description_text = fromArchive
      ? row.description_json === null
        ? ''
        : richTextToPlain(row.description_json)
      : row.description_text;
  if (table === 'lesson' && row.type === 'TEXT') values.content_json = row.content_json;
  return values;
}

export async function requireRecoveryOwner(tx: TenantTx): Promise<string> {
  const staffId = currentContext()?.platformUserId;
  if (!staffId) throw new AppError('FORBIDDEN');
  const staff = await tx.platformUser.findFirst({
    where: { id: staffId, status: 'ACTIVE', role: 'PLATFORM_OWNER' },
  });
  if (!staff) throw new AppError('FORBIDDEN');
  return staffId;
}

async function planInTx(
  tx: TenantTx,
  tenantId: string,
  source: Record<Table, Row[]>,
): Promise<SchoolRecoveryPlan> {
  const staffId = await requireRecoveryOwner(tx);
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant || tenant.status === 'DELETED') throw new Error('Recovery school unavailable');
  const changes: SchoolRecoveryPlan['changes'] = [];
  const blockers: SchoolRecoveryPlan['blockers'] = [];
  const current: Record<string, Row[]> = {};
  for (const table of tables) {
    // Identifiers are compile-time allowlisted; values are bound. Lock target rows for the entire
    // re-review/apply/audit transaction. RLS remains forced and the school predicate is explicit.
    const rows = await tx.$queryRaw<Array<{ data: Row }>>`
      SELECT to_jsonb(t) AS data FROM ${Prisma.raw(`"${table}"`)} t
      WHERE tenant_id=${tenantId}::uuid AND id=ANY(${source[table].map((row) => row.id)}::uuid[])
      ORDER BY id FOR UPDATE`;
    current[table] = rows.map((row) => row.data);
    const byId = new Map(rows.map(({ data }) => [data.id, data]));
    for (const saved of source[table]) {
      const live = byId.get(saved.id);
      const id = String(saved.id);
      if (!live) {
        blockers.push({ table, id, reason: 'Record missing; recreation is outside this scope' });
        continue;
      }
      if (
        (table !== 'course' && saved.course_id !== live.course_id) ||
        (table === 'lesson' && (saved.section_id !== live.section_id || saved.type !== live.type))
      ) {
        blockers.push({ table, id, reason: 'Parent or lesson type changed; review references separately' });
        continue;
      }
      const before = fields(table, live, false);
      const after = fields(table, saved, true);
      if (canonical(before) !== canonical(after)) changes.push({ table, id, before, after });
    }
  }
  return {
    scope: SCOPE,
    tenantId,
    changes,
    blockers,
    reviewDigest: recoveryDigest({ scope: SCOPE, tenantId, staffId, source, current }),
  };
}

export async function planSchoolContentRecovery(
  prisma: PrismaClient,
  tenantId: string,
  entries: ReadonlyMap<string, Buffer>,
): Promise<SchoolRecoveryPlan> {
  const source = readArchive(tenantId, entries);
  return runInPlatformTenantTx(prisma, tenantId, (tx) => planInTx(tx, tenantId, source));
}

export async function applySchoolContentRecovery(
  prisma: PrismaClient,
  tenantId: string,
  entries: ReadonlyMap<string, Buffer>,
  review: { digest: string; reason: string; ownerReviewReference: string },
): Promise<{ changed: number }> {
  const approval = z
    .object({
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      reason: z.string().trim().min(10).max(500),
      ownerReviewReference: z.string().trim().min(3).max(200),
    })
    .parse(review);
  const source = readArchive(tenantId, entries);
  return runInPlatformTenantTx(prisma, tenantId, async (tx) => {
    const plan = await planInTx(tx, tenantId, source);
    if (plan.reviewDigest !== approval.digest)
      throw new Error('Recovery review is stale or belongs to another source/operator');
    if (plan.blockers.length) throw new Error('Recovery is blocked by missing or changed references');
    if (!plan.changes.length) return { changed: 0 };
    for (const change of plan.changes) {
      const columns = Object.keys(change.after);
      // Columns come exclusively from fields() above, never archive keys.
      const assignments = columns.map((column) => `"${column}"=s."${column}"`).join(',');
      const version = change.table === 'section' ? '' : ', version=t.version+1, updated_at=now()';
      const table = Prisma.raw(`"${change.table}"`);
      const count = await tx.$executeRaw`
        UPDATE ${table} t SET ${Prisma.raw(assignments + version)}
        FROM jsonb_populate_record(NULL::${table}, ${JSON.stringify(change.after)}::jsonb) s
        WHERE t.tenant_id=${tenantId}::uuid AND t.id=${change.id}::uuid`;
      if (count !== 1) throw new Error('Recovery target changed');
    }
    const actorId = await requireRecoveryOwner(tx);
    const summary = {
      scope: SCOPE,
      reviewDigest: approval.digest,
      reason: approval.reason,
      ownerReviewReference: approval.ownerReviewReference,
      changed: plan.changes.length,
      records: plan.changes.map(({ table, id }) => ({ table, id })),
    };
    // Append both records atomically with the updates; never copy or roll back historical audit.
    await tx.auditLog.create({
      data: {
        tenantId,
        actorId,
        action: 'school.recovered',
        entityType: 'tenant',
        entityId: tenantId,
        requestId: currentContext()?.requestId ?? null,
        after: summary,
      },
    });
    await tx.platformAuditLog.create({
      data: {
        actorId,
        tenantRef: tenantId,
        action: 'school.recovered',
        entityType: 'tenant',
        entityId: tenantId,
        requestId: currentContext()?.requestId ?? null,
        after: summary,
      },
    });
    return { changed: plan.changes.length };
  });
}
