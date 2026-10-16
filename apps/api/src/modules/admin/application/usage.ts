import { Injectable } from '@nestjs/common';
import type { AdminUsage, UsageDay, UsageMeter } from '@studyhub/contracts';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

import type { PrismaClient } from '../../../generated/prisma/client';
import type { TenantActor } from '../../identity';
import {
  enqueue,
  type JobEnvelope,
  type ObjectStorage,
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
 * deletes every other school row and marks the school DELETED; then the school's objects are removed.
 */
export function createPurgeHandler(deps: { prisma: PrismaClient; storage: ObjectStorage }) {
  return async (_envelope: JobEnvelope, logger: Logger): Promise<{ deleted: number }> => {
    const tenantId = requireTenantId();
    const [row] = await runInTenantTx(
      deps.prisma,
      (tx) => tx.$queryRaw<{ deleted: bigint }[]>`SELECT purge_tenant(${tenantId}::uuid) AS deleted`,
    );
    const deleted = Number(row?.deleted ?? -1n);
    if (deleted < 0) return { deleted: 0 };
    const objects = await deps.storage.deletePrefix(`t/${tenantId}/`);
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
