import type { Readable } from 'node:stream';

import type { Logger } from 'pino';

import { Prisma, type PrismaClient } from '../../../generated/prisma/client';
import {
  addToOutbox,
  type JobEnvelope,
  lockTenantLifecycle,
  type StorageLocations,
  queueEmail,
  requireTenantId,
  runInTenantTx,
  type SecretBox,
  type TenantTx,
} from '../../platform';
import { toCsv } from '../../platform';
import { readFeatures } from '../../tenancy';
import { buildZip, type ZipEntry } from '../domain/zip';
import { dayRange } from './report-queries';

/** Worker queue for exports (F32 report CSVs and the F46 full export). */
export const EXPORT_JOB = 'admin.export';
/** Download links work for 7 days (05 §8.5). */
export const EXPORT_TTL_MS = 7 * 24 * 3600_000;
/** Media files larger than this are listed in the full export, not copied (videos live at the video provider). */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

export type ReportExportType = 'ORDERS' | 'PAYMENTS' | 'LEDGER' | 'ENROLMENTS';

/** Queues the worker in the caller's transaction (the export row and its job commit together). */
export async function queueExport(tx: TenantTx, exportId: string): Promise<void> {
  await addToOutbox(tx, EXPORT_JOB, { exportId });
}

const memberName = (
  m: { displayNameOverride: string | null; user: { displayName: string } } | null | undefined,
) => (m === null || m === undefined ? null : (m.displayNameOverride ?? m.user.displayName));

/**
 * The report CSVs. Their filters are the dashboard's (report-queries.ts), so totals match (F32 AC):
 * PAYMENTS lists payments confirmed in the range (and unconfirmed ones created in it); summing the
 * SUCCEEDED and REFUNDED rows gives the dashboard's gross sales.
 */
export async function reportCsv(
  tx: TenantTx,
  type: ReportExportType,
  from: string,
  to: string,
): Promise<{ csv: string; rows: number }> {
  const range = dayRange(from, to);
  const between = { gte: range.start, lt: range.end };
  switch (type) {
    case 'ORDERS': {
      const orders = await tx.order.findMany({
        where: { createdAt: between },
        orderBy: { createdAt: 'asc' },
        include: { items: { take: 1 }, receipt: { select: { number: true } } },
      });
      const buyers = await members(
        tx,
        orders.map((o) => o.membershipId),
      );
      return {
        rows: orders.length,
        csv: toCsv(
          [
            'order_id',
            'created_at',
            'status',
            'paid_at',
            'refunded_at',
            'course',
            'amount_minor',
            'currency',
            'buyer_name',
            'buyer_email',
            'receipt_number',
          ],
          orders.map((o) => {
            const buyer = buyers.get(o.membershipId);
            return [
              o.id,
              o.createdAt,
              o.status,
              o.paidAt,
              o.refundedAt,
              o.items[0]?.titleSnapshot,
              o.totalMinor,
              o.currency,
              memberName(buyer),
              buyer?.user.email,
              o.receipt?.number,
            ];
          }),
        ),
      };
    }
    case 'PAYMENTS': {
      const payments = await tx.payment.findMany({
        where: { OR: [{ confirmedAt: between }, { confirmedAt: null, createdAt: between }] },
        orderBy: { createdAt: 'asc' },
        include: { refunds: { where: { status: 'SUCCEEDED' }, select: { amountMinor: true } } },
      });
      return {
        rows: payments.length,
        csv: toCsv(
          [
            'reference',
            'order_id',
            'created_at',
            'confirmed_at',
            'status',
            'method',
            'network',
            'amount_minor',
            'currency',
            'provider_fee_minor',
            'refunded_minor',
          ],
          payments.map((p) => [
            p.reference,
            p.orderId,
            p.createdAt,
            p.confirmedAt,
            p.status,
            p.method,
            p.network,
            p.amountMinor,
            p.currency,
            p.providerFeeMinor,
            p.refunds.reduce((total, r) => total + r.amountMinor, 0n),
          ]),
        ),
      };
    }
    case 'LEDGER': {
      const entries = await tx.ledgerEntry.findMany({
        where: { createdAt: between },
        orderBy: { createdAt: 'asc' },
        include: { orderItem: { select: { titleSnapshot: true } } },
      });
      const instructors = await members(
        tx,
        entries.map((e) => e.instructorMembershipId),
      );
      return {
        rows: entries.length,
        csv: toCsv(
          [
            'entry_id',
            'created_at',
            'type',
            'status',
            'instructor',
            'course',
            'gross_minor',
            'provider_fee_minor',
            'commission_minor',
            'net_minor',
            'currency',
            'available_at',
            'payout_id',
          ],
          entries.map((e) => [
            e.id,
            e.createdAt,
            e.type,
            e.status,
            memberName(instructors.get(e.instructorMembershipId)),
            e.orderItem?.titleSnapshot,
            e.grossMinor,
            e.providerFeeMinor,
            e.commissionMinor,
            e.netMinor,
            e.currency,
            e.availableAt,
            e.payoutId,
          ]),
        ),
      };
    }
    case 'ENROLMENTS': {
      const enrolments = await tx.enrollment.findMany({
        where: { startedAt: between },
        orderBy: { startedAt: 'asc' },
        include: { course: { select: { title: true } } },
      });
      const learners = await members(
        tx,
        enrolments.map((e) => e.membershipId),
      );
      return {
        rows: enrolments.length,
        csv: toCsv(
          [
            'enrolment_id',
            'started_at',
            'course',
            'learner_name',
            'learner_email',
            'source',
            'status',
            'progress_percent',
            'completed_at',
            'expires_at',
          ],
          enrolments.map((e) => {
            const learner = learners.get(e.membershipId);
            return [
              e.id,
              e.startedAt,
              e.course.title,
              memberName(learner),
              learner?.user.email,
              e.source,
              e.status,
              e.progressPercent,
              e.completedAt,
              e.expiresAt,
            ];
          }),
        ),
      };
    }
  }
}

async function members(tx: TenantTx, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows =
    unique.length === 0
      ? []
      : await tx.tenantMembership.findMany({
          where: { id: { in: unique } },
          select: {
            id: true,
            displayNameOverride: true,
            user: { select: { displayName: true, email: true } },
          },
        });
  return new Map(rows.map((r) => [r.id, r]));
}

/** Tables the school export never includes: credential material lives only as hashes or ciphertext. */
const SKIPPED_TABLES = new Set(['tenant_archive', 'idempotency_key', 'outbox', 'support_session', 'session']);

function jsonValue(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return undefined; // hashes and ciphertext are never exported
  if (value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'Buffer')
    return undefined;
  return value;
}

/**
 * The full school export (F46): one JSON file per school table (RLS limits every query to this school,
 * F46 AC 1), CSV summaries, and the school's images and documents. Binary columns (hashes, ciphertext)
 * are left out.
 */
export async function fullExport(
  tx: TenantTx,
  locations: StorageLocations,
): Promise<{ entries: ZipEntry[]; rows: number }> {
  const tenantId = requireTenantId();
  // Each table with the columns that are never exported: binary (hashes, ciphertext) and search vectors.
  const tables = await tx.$queryRaw<{ name: string; hidden: string[] }[]>`
    SELECT c.relname AS name,
           coalesce(array_agg(a.attname::text) FILTER (WHERE t.typname IN ('bytea', 'tsvector')), '{}') AS hidden
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      JOIN pg_type t ON t.oid = a.atttypid
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
       AND has_table_privilege(c.oid, 'SELECT')
     GROUP BY c.relname
     ORDER BY c.relname`;
  const entries: ZipEntry[] = [];
  let rows = 0;
  for (const { name, hidden } of tables) {
    if (SKIPPED_TABLES.has(name) || !/^[a-z_]+$/.test(name)) continue;
    // Rows are serialised by PostgreSQL itself (to_jsonb), so every column type exports faithfully.
    // The table name comes from the catalogue and is checked against /^[a-z_]+$/ above.
    const data = await tx.$queryRaw<{ row: Record<string, unknown> }[]>`
      SELECT to_jsonb(t) - ${hidden}::text[] AS row FROM ${Prisma.raw(`"${name}"`)} t WHERE t.tenant_id = ${tenantId}::uuid`;
    rows += data.length;
    entries.push({
      name: `data/${name}.json`,
      data: Buffer.from(
        JSON.stringify(
          data.map((d) => d.row),
          jsonValue,
          2,
        ),
      ),
    });
  }
  const tenant = await tx.tenant.findFirst({
    select: {
      id: true,
      slug: true,
      name: true,
      legalName: true,
      kind: true,
      status: true,
      country: true,
      currency: true,
      createdAt: true,
    },
  });
  entries.push({ name: 'data/tenant.json', data: Buffer.from(JSON.stringify(tenant, jsonValue, 2)) });

  const people = await tx.tenantMembership.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      joinedAt: true,
      displayNameOverride: true,
      user: { select: { displayName: true, email: true } },
      roles: { select: { role: true } },
    },
  });
  entries.push({
    name: 'summaries/members.csv',
    data: Buffer.from(
      toCsv(
        ['membership_id', 'name', 'email', 'roles', 'status', 'joined_at'],
        people.map((p) => [
          p.id,
          memberName(p),
          p.user.email,
          p.roles.map((r) => r.role).join(' '),
          p.status,
          p.joinedAt,
        ]),
      ),
    ),
  });
  for (const type of ['ORDERS', 'PAYMENTS', 'LEDGER', 'ENROLMENTS'] as const) {
    const { csv } = await reportCsv(tx, type, '2000-01-01', new Date().toISOString().slice(0, 10));
    entries.push({ name: `summaries/${type.toLowerCase()}.csv`, data: Buffer.from(csv) });
  }

  const assets = await tx.asset.findMany({
    where: { status: 'READY', kind: { in: ['IMAGE', 'DOCUMENT'] }, storageKey: { not: null } },
    select: {
      id: true,
      originalName: true,
      sizeBytes: true,
      storageKey: true,
      storageLocationId: true,
      mime: true,
    },
  });
  let mediaBytes = 0;
  const listing: unknown[][] = [];
  for (const asset of assets) {
    const size = Number(asset.sizeBytes);
    const include = size <= MAX_FILE_BYTES && mediaBytes + size <= MAX_MEDIA_BYTES;
    if (include) {
      // Resolve provenance outside the missing-object catch: an unbound or retired location must
      // fail the export rather than silently falling back to whichever destination is active now.
      const storage = await locations.at(asset.storageLocationId, tenantId);
      try {
        const data = await streamToBuffer(await storage.stream(asset.storageKey!));
        entries.push({ name: `files/${asset.id}-${asset.originalName.replace(/[^\w.-]+/g, '_')}`, data });
        mediaBytes += size;
      } catch {
        listing.push([asset.id, asset.originalName, asset.mime, size, 'missing from storage']);
        continue;
      }
    }
    listing.push([
      asset.id,
      asset.originalName,
      asset.mime,
      size,
      include ? 'included' : 'too large to include',
    ]);
  }
  entries.push({
    name: 'summaries/files.csv',
    data: Buffer.from(toCsv(['asset_id', 'name', 'type', 'size_bytes', 'export'], listing)),
  });
  return { entries, rows };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

export interface ExportDeps {
  prisma: PrismaClient;
  locations: StorageLocations;
  box: SecretBox;
  /** e.g. "http://{host}" — links in the "export ready" email. */
  schoolUrlTemplate: string;
}

/** Worker handler for `admin.export` (runs in the job's school context). Idempotent: READY rows are skipped. */
export function createExportHandler(deps: ExportDeps) {
  return async (envelope: JobEnvelope, logger: Logger): Promise<{ status: string }> => {
    const exportId = String((envelope.payload as { exportId?: unknown }).exportId ?? '');
    const tenantId = requireTenantId();
    const claim = await runInTenantTx(deps.prisma, async (tx) => {
      // Serialize claims with purge eligibility. Purge waits for RUNNING exports; queued/failed
      // exports cannot become writers after the deadline. An existing RUNNING job may finish/retry.
      const tenant = await lockTenantLifecycle(tx, tenantId);
      const current = await tx.dataExport.findFirst({
        where: { id: exportId },
        select: { id: true, type: true, status: true, params: true, storageLocationId: true },
      });
      if (
        tenant === undefined ||
        current === null ||
        current.status === 'READY' ||
        current.status === 'EXPIRED'
      ) {
        return { status: 'skipped', job: null };
      }
      if (tenant.blocked && current.status !== 'RUNNING') {
        await tx.dataExport.update({
          where: { id: exportId },
          data: { status: 'FAILED', error: 'SCHOOL_READ_ONLY' },
        });
        return { status: 'SCHOOL_READ_ONLY', job: null };
      }
      if (current.type === 'TENANT_FULL' && !(await readFeatures(tx)).dataExport) {
        await tx.dataExport.update({
          where: { id: exportId },
          data: { status: 'FAILED', error: 'FEATURE_NOT_ENABLED' },
        });
        return { status: 'FEATURE_NOT_ENABLED', job: null };
      }
      await tx.dataExport.update({ where: { id: exportId }, data: { status: 'RUNNING' } });
      return { status: 'RUNNING', job: current };
    });
    const job = claim.job;
    if (job === null) return { status: claim.status };
    try {
      const storage = await deps.locations.at(job.storageLocationId, tenantId);
      const params = job.params as { from?: string; to?: string };
      const built = await runInTenantTx(deps.prisma, async (tx) => {
        if (job.type === 'TENANT_FULL') {
          const full = await fullExport(tx, deps.locations);
          return { body: buildZip(full.entries), rows: full.rows, ext: 'zip', type: 'application/zip' };
        }
        const report = await reportCsv(tx, job.type, params.from ?? '2000-01-01', params.to ?? '2100-01-01');
        return { body: Buffer.from(report.csv), rows: report.rows, ext: 'csv', type: 'text/csv' };
      });
      const key = `t/${tenantId}/exports/${exportId}.${built.ext}`;
      await storage.put(key, built.body, built.type);
      const finished = await runInTenantTx(deps.prisma, async (tx) => {
        // Only while this worker still holds the claim: a purge retires exports abandoned for a day.
        const claimed = await tx.dataExport.updateMany({
          where: { id: exportId, status: 'RUNNING' },
          data: {
            status: 'READY',
            storageKey: key,
            storageLocationId: job.storageLocationId,
            rowCount: built.rows,
            sizeBytes: BigInt(built.body.length),
            completedAt: new Date(),
            expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
          },
        });
        if (claimed.count === 0) return false;
        const row = await tx.dataExport.findUniqueOrThrow({
          where: { id: exportId },
          select: { requestedBy: true },
        });
        const requester = await tx.tenantMembership.findFirst({
          where: { id: row.requestedBy },
          select: { displayNameOverride: true, user: { select: { email: true, displayName: true } } },
        });
        const school = await tx.tenantBranding.findFirst({ select: { displayName: true } });
        const host = (await tx.$queryRaw<{ host: string | null }[]>`SELECT current_school_host() AS host`)[0]
          ?.host;
        if (requester !== null) {
          await queueEmail(tx, deps.box, {
            template: 'export-ready',
            to: requester.user.email,
            vars: {
              schoolName: school?.displayName ?? 'Your school',
              displayName: requester.displayNameOverride ?? requester.user.displayName,
              link:
                host === null || host === undefined
                  ? ''
                  : `${deps.schoolUrlTemplate.replace('{host}', host)}/admin/exports`,
            },
          });
        }
        return true;
      });
      if (!finished) {
        // Retired while this worker was stalled: leave nothing behind in a school being purged.
        await storage.delete(key).catch(() => undefined);
        logger.warn({ exportId }, 'Export finished after its claim was retired; file removed');
        return { status: 'abandoned' };
      }
      logger.info({ exportId, type: job.type, rows: built.rows, bytes: built.body.length }, 'Export ready');
      return { status: 'READY' };
    } catch (error) {
      await runInTenantTx(deps.prisma, (tx) =>
        tx.dataExport.updateMany({
          where: { id: exportId, status: 'RUNNING' },
          data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 300) : 'failed' },
        }),
      );
      throw error;
    }
  };
}
