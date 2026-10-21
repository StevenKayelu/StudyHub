import { Injectable } from '@nestjs/common';
import type { AdminUsage, UsageDay, UsageMeter } from '@studyhub/contracts';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

import type { PrismaClient } from '../../../generated/prisma/client';
import type { TenantActor } from '../../identity';
import {
  AppError,
  enqueue,
  type JobEnvelope,
  lockTenantLifecycle,
  type StorageLocations,
  requireTenantId,
  runInPlatformTx,
  runInTenantTx,
  type SecretBox,
  TenantDb,
  type TenantTx,
} from '../../platform';
import { countUsage, limitOf, meterPercent, meterState, noteUsageLevel, readPlan } from '../../tenancy';
import { requireAdmin } from './guards';

/** Named system job `usage.meter.daily` (04 §17.4): one job per school, run from an hourly sweep. */
export const USAGE_METER_JOB = 'admin.usage-meter';
/** Named system job `tenants.purge` (F46, BR-53). */
export const PURGE_JOB = 'admin.tenant-purge';

const DAY_MS = 86_400_000;

export function usageDay(row: {
  date: Date;
  activeLearners: number;
  instructors: number;
  admins: number;
  storageBytes: bigint;
  videoMinutesDelivered: number;
  emailsSent: number;
  paymentsCount: number;
  paymentsAmountMinor: bigint;
}): UsageDay {
  return {
    date: row.date.toISOString().slice(0, 10),
    activeLearners: row.activeLearners,
    instructors: row.instructors,
    admins: row.admins,
    storageBytes: Number(row.storageBytes),
    videoMinutesDelivered: row.videoMinutesDelivered,
    emailsSent: row.emailsSent,
    paymentsCount: row.paymentsCount,
    paymentsAmountMinor: Number(row.paymentsAmountMinor),
  };
}

/**
 * Measures one school for one day (F47) in its own context and stores it. Payments and emails count
 * what happened that day; members and storage are the state at measurement time. Video minutes stay
 * 0: the fake video provider reports none (a real provider's usage API fills it later).
 */
export async function measureTenant(
  tx: TenantTx,
  box: SecretBox | null,
  now = new Date(),
): Promise<UsageDay> {
  const tenantId = requireTenantId();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const next = new Date(date.getTime() + DAY_MS);
  const activeLearners = await countUsage(tx, 'activeLearners');
  const instructors = await countUsage(tx, 'instructors');
  const admins = await countUsage(tx, 'admins');
  const usage = await tx.tenantUsage.findFirst({ select: { storageBytes: true } });
  const storageBytes = usage?.storageBytes ?? 0n;
  const emailsSent = await tx.outbox.count({
    where: { topic: 'email.send', dispatchedAt: { gte: date, lt: next } },
  });
  const [payments] = await tx.$queryRaw<{ count: bigint; amount: bigint | null }[]>`
    SELECT count(*)::bigint AS count, sum(amount_minor)::bigint AS amount FROM payment
     WHERE status IN ('SUCCEEDED', 'REFUNDED') AND confirmed_at >= ${date} AND confirmed_at < ${next}`;
  const values = {
    activeLearners,
    instructors,
    admins,
    storageBytes,
    videoMinutesDelivered: 0,
    emailsSent,
    paymentsCount: Number(payments?.count ?? 0n),
    paymentsAmountMinor: payments?.amount ?? 0n,
    measuredAt: now,
  };
  const previous = await tx.tenantUsageDaily.findFirst({
    where: { date: { lt: date } },
    orderBy: { date: 'desc' },
    select: { storageBytes: true },
  });
  const row = await tx.tenantUsageDaily.upsert({
    where: { tenantId_date: { tenantId, date } },
    create: { tenantId, date, ...values },
    update: values,
  });
  if (box !== null) {
    const plan = await readPlan(tx);
    await noteUsageLevel(
      tx,
      box,
      'storage',
      Number(previous?.storageBytes ?? 0n),
      Number(storageBytes),
      limitOf(plan.limits, 'storage'),
    );
  }
  return usageDay(row);
}

export interface SweepDeps {
  prisma: PrismaClient;
  boss: PgBoss;
}

/**
 * The hourly sweep: in the console realm, lists schools (ids and lifecycle only) and enqueues one
 * metering job each, plus a purge job for every school whose offboarding grace period has passed.
 */
export async function sweepTenants(deps: SweepDeps): Promise<{ metered: number; purged: number }> {
  const tenants = await runInPlatformTx(deps.prisma, (tx) =>
    tx.tenant.findMany({
      where: { status: { not: 'DELETED' } },
      select: { id: true, status: true, deleteAfter: true },
    }),
  );
  let purged = 0;
  const now = Date.now();
  for (const tenant of tenants) {
    await enqueue(deps.boss, USAGE_METER_JOB, {}, { tenantId: tenant.id });
    if (
      tenant.status === 'OFFBOARDING' &&
      tenant.deleteAfter !== null &&
      tenant.deleteAfter.getTime() <= now
    ) {
      await enqueue(deps.boss, PURGE_JOB, {}, { tenantId: tenant.id });
      purged += 1;
    }
  }
  return { metered: tenants.length, purged };
}

export function createUsageMeterHandler(deps: { prisma: PrismaClient; box: SecretBox }) {
  return async (_envelope: JobEnvelope, logger: Logger): Promise<UsageDay> => {
    const day = await runInTenantTx(deps.prisma, (tx) => measureTenant(tx, deps.box));
    logger.info({ date: day.date }, 'School usage measured');
    return day;
  };
}

/**
 * `tenants.purge` (F46 AC 2, BR-53): purge_tenant() archives financial records and the audit trail,
 * deletes every other school row and marks the school DELETED after all retained object locations
 * have been cleaned. A failed cleanup leaves lifecycle metadata intact so the job can retry.
 */
/**
 * A scan or export with no progress for this long is abandoned: jobs expire after minutes and retries
 * back off over hours, so no live worker is this old. The purge retires it instead of waiting forever.
 */
export const ABANDONED_WRITER_MS = 24 * 3600_000;

export function createPurgeHandler(deps: { prisma: PrismaClient; locations: StorageLocations }) {
  return async (_envelope: JobEnvelope, logger: Logger): Promise<{ deleted: number }> => {
    const tenantId = requireTenantId();
    const eligible = async () => {
      const busy = await runInTenantTx(deps.prisma, async (tx) => {
        if ((await lockTenantLifecycle(tx, tenantId))?.purgeDue !== true) return null;
        // Export/media workers claim these states under this same tenant lock. Existing writers
        // finish first; new claims are refused once offboarding is due, so no object can appear
        // after its retained location has been cleaned. A writer stuck for a day is retired here;
        // its worker, if it ever resumes, finds its claim gone and deletes what it wrote.
        const stale = new Date(Date.now() - ABANDONED_WRITER_MS);
        const retiredExports = await tx.dataExport.updateMany({
          where: { status: 'RUNNING', createdAt: { lt: stale } },
          data: { status: 'FAILED', error: 'ABANDONED' },
        });
        const retiredAssets = await tx.asset.updateMany({
          where: { status: 'SCANNING', updatedAt: { lt: stale } },
          data: { status: 'REJECTED', rejectReason: 'Processing never finished.', updatedAt: new Date() },
        });
        if (retiredExports.count > 0 || retiredAssets.count > 0) {
          logger.warn(
            { retiredExports: retiredExports.count, retiredAssets: retiredAssets.count },
            'School purge retired abandoned object writers',
          );
        }
        return {
          exports: await tx.dataExport.count({ where: { status: 'RUNNING' } }),
          assets: await tx.asset.count({ where: { status: 'SCANNING' } }),
        };
      });
      if (busy === null) return false;
      if (busy.exports > 0 || busy.assets > 0) {
        // A writer that never finishes would block the purge on every daily retry: make that visible.
        logger.warn(
          { runningExports: busy.exports, scanningAssets: busy.assets },
          'School purge is due but waits for in-flight object writers',
        );
        return false;
      }
      return true;
    };
    if (!(await eligible())) return { deleted: 0 };
    const locations = [...new Set(await deps.locations.retained())];
    if (locations.length === 0) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'No retained storage locations are available for safe cleanup.',
      });
    }
    const references = await runInTenantTx(
      deps.prisma,
      (tx) =>
        tx.$queryRaw<{ locationId: string | null }[]>`
        SELECT DISTINCT storage_location_id AS "locationId" FROM asset
         WHERE storage_key IS NOT NULL OR derivative_key IS NOT NULL
        UNION
        SELECT DISTINCT storage_location_id AS "locationId" FROM data_export
         WHERE storage_key IS NOT NULL`,
    );
    const retained = new Set(locations);
    if (
      references.some((reference) => reference.locationId === null || !retained.has(reference.locationId))
    ) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail:
          'Recorded objects have unresolved storage locations. Capture their original storage before retrying cleanup.',
      });
    }
    // Resolve adapters before starting destructive work. A location holding this school's recorded
    // objects is required: missing credentials leave everything in place for repair. Other retained
    // (superseded) locations are cleaned when they can be opened; one whose credentials were revoked
    // is logged and skipped rather than blocking every purge (M10 review).
    const referenced = new Set(references.map((reference) => reference.locationId));
    const adapters = [];
    for (const locationId of locations) {
      try {
        adapters.push(await deps.locations.at(locationId, tenantId));
      } catch (error) {
        if (referenced.has(locationId)) throw error;
        logger.warn({ locationId }, 'School purge skipped a superseded storage location it could not open');
      }
    }
    let objects = 0;
    for (const storage of adapters) {
      // Recheck after adapter resolution and immediately before destructive I/O. Cancellation is
      // forbidden once deleteAfter has passed; cancellation writers must enforce that atomically.
      if (!(await eligible())) return { deleted: 0 };
      objects += await storage.deletePrefix(`t/${tenantId}/`);
    }
    if (!(await eligible())) return { deleted: 0 };
    const [row] = await runInTenantTx(
      deps.prisma,
      (tx) => tx.$queryRaw<{ deleted: bigint }[]>`SELECT purge_tenant(${tenantId}::uuid) AS deleted`,
    );
    const deleted = Number(row?.deleted ?? -1n);
    if (deleted < 0) return { deleted: 0 };
    logger.warn({ deleted, objects }, 'School purged after offboarding');
    return { deleted };
  };
}

/** Usage & plan (F47, S-AD17). */
@Injectable()
export class UsageService {
  constructor(private readonly db: TenantDb) {}

  async usage(actor: TenantActor): Promise<AdminUsage> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const plan = await readPlan(tx);
      const month = new Date();
      const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
      const video = await tx.tenantUsageDaily.aggregate({
        where: { date: { gte: monthStart } },
        _sum: { videoMinutesDelivered: true },
      });
      const meter = (key: UsageMeter['key'], used: number, limit: number | null): UsageMeter => ({
        key,
        used,
        limit,
        percent: meterPercent(used, limit),
        state: meterState(used, limit),
      });
      const daily = await tx.tenantUsageDaily.findMany({
        where: { date: { gte: new Date(Date.now() - 30 * DAY_MS) } },
        orderBy: { date: 'asc' },
      });
      return {
        plan: { code: plan.code, name: plan.name, limits: plan.limits, features: plan.features ?? {} },
        meters: [
          meter('activeLearners', await countUsage(tx, 'activeLearners'), plan.limits.maxActiveLearners),
          meter('instructors', await countUsage(tx, 'instructors', true), plan.limits.maxInstructors),
          meter('admins', await countUsage(tx, 'admins', true), plan.limits.maxAdmins),
          meter('storage', await countUsage(tx, 'storage'), limitOf(plan.limits, 'storage')),
          meter('videoMinutes', video._sum.videoMinutesDelivered ?? 0, plan.limits.videoMinutesPerMonth),
        ],
        daily: daily.map(usageDay),
      };
    });
  }
}
