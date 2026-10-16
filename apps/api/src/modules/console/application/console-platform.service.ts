import { Injectable } from '@nestjs/common';
import {
  type ConsoleAuditPage,
  type ConsoleMetrics,
  type ConsoleOverview,
  type ConsolePlan,
  type ConsoleSettings,
  DEFAULT_CONSOLE_SETTINGS,
  type PlanFeatures,
  type PlanLimits,
  type PlanPricing,
  type ProviderHealth,
} from '@studyhub/contracts';

import type { Prisma } from '../../../generated/prisma/client';
import {
  AppError,
  ConfigService,
  hashPassword,
  PrismaService,
  TenantDb,
  type TenantTx,
} from '../../platform';
import { limitOf, MAINTENANCE_BANNER_KEY, meterPercent, planFromRow } from '../../tenancy';
import type { ConsoleActor, PlatformRole } from './console-auth.service';
import { latestUsage } from './console-tenants.service';
import { recordPlatform } from './platform-audit';

const SUPPORT_MAX_KEY = 'supportMaxHours';

/**
 * Platform-level console screens (F43): plans (S-C06), staff (S-C07), global settings and provider
 * health (S-C08), the platform audit log (S-C09), the overview (S-C02) and aggregated metrics. Counts and
 * sums only: no school member data.
 */
@Injectable()
export class ConsolePlatformService {
  constructor(
    private readonly db: TenantDb,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // --- Plans (S-C06) ---------------------------------------------------------------------------------

  async plans(): Promise<{ plans: ConsolePlan[] }> {
    return this.db.runPlatform(async (tx) => {
      const plans = await tx.plan.findMany({
        orderBy: { code: 'asc' },
        include: { _count: { select: { tenants: true } } },
      });
      return { plans: plans.map((plan) => toPlan(plan, plan._count.tenants)) };
    });
  }

  async createPlan(
    actor: ConsoleActor,
    input: {
      code: string;
      name: string;
      features: PlanFeatures;
      limits: PlanLimits;
      pricing: PlanPricing;
      isPublic: boolean;
    },
  ): Promise<ConsolePlan> {
    return this.db.runPlatform(async (tx) => {
      if ((await tx.plan.findUnique({ where: { code: input.code } })) !== null) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'code', code: 'taken', message: 'This code is already used' }],
        });
      }
      const plan = await tx.plan.create({
        data: {
          code: input.code,
          name: input.name,
          features: input.features as object,
          limits: input.limits as object,
          pricing: input.pricing as object,
          isPublic: input.isPublic,
        },
      });
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'plan.created',
        entityType: 'plan',
        entityId: plan.id,
        after: input as never,
      });
      return toPlan(plan, 0);
    });
  }

  async updatePlan(
    actor: ConsoleActor,
    id: string,
    input: {
      name?: string | undefined;
      features?: PlanFeatures | undefined;
      limits?: PlanLimits | undefined;
      pricing?: PlanPricing | undefined;
      isPublic?: boolean | undefined;
      status?: 'ACTIVE' | 'RETIRED' | undefined;
      reason: string;
    },
  ): Promise<ConsolePlan> {
    return this.db.runPlatform(async (tx) => {
      const before = await tx.plan.findUnique({
        where: { id },
        include: { _count: { select: { tenants: true } } },
      });
      if (before === null) throw new AppError('NOT_FOUND');
      const plan = await tx.plan.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.features !== undefined && { features: input.features as object }),
          ...(input.limits !== undefined && { limits: input.limits as object }),
          ...(input.pricing !== undefined && { pricing: input.pricing as object }),
          ...(input.isPublic !== undefined && { isPublic: input.isPublic }),
          ...(input.status !== undefined && { status: input.status }),
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'plan.updated',
        entityType: 'plan',
        entityId: id,
        before: {
          features: before.features,
          limits: before.limits,
          pricing: before.pricing,
          status: before.status,
        } as never,
        after: { ...input, affectedTenants: before._count.tenants } as never,
      });
      return toPlan(plan, before._count.tenants);
    });
  }

  // --- Staff (S-C07) ---------------------------------------------------------------------------------

  /** Owners create staff with an initial password; two-step enrolment is forced at first sign-in (PROPOSED 8). */
  async createStaff(
    actor: ConsoleActor,
    input: { email: string; displayName: string; role: PlatformRole; password: string },
  ): Promise<{ id: string }> {
    const passwordHash = await hashPassword(input.password);
    return this.db.runPlatform(async (tx) => {
      if ((await tx.platformUser.findUnique({ where: { email: input.email } })) !== null) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'email', code: 'taken', message: 'This email already has a staff account' }],
        });
      }
      const user = await tx.platformUser.create({
        data: { email: input.email, displayName: input.displayName, role: input.role },
        select: { id: true },
      });
      await tx.platformCredential.create({ data: { userId: user.id, passwordHash } });
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'console.staff_created',
        entityType: 'platform_user',
        entityId: user.id,
        after: { role: input.role },
      });
      return user;
    });
  }

  async changeStaffRole(actor: ConsoleActor, staffId: string, role: PlatformRole): Promise<void> {
    if (staffId === actor.userId)
      throw new AppError('FORBIDDEN', { detail: "You can't change your own role." });
    await this.db.runPlatform(async (tx) => {
      const target = await tx.platformUser.findUnique({ where: { id: staffId }, select: { role: true } });
      if (target === null) throw new AppError('NOT_FOUND');
      if (target.role === role) return;
      await tx.platformUser.update({
        where: { id: staffId },
        data: { role, updatedAt: new Date(), version: { increment: 1 } },
      });
      // New rights take effect at the next sign-in.
      await tx.platformSession.deleteMany({ where: { userId: staffId } });
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'console.staff_role_changed',
        entityType: 'platform_user',
        entityId: staffId,
        before: { role: target.role },
        after: { role },
      });
    });
  }

  // --- Global settings (S-C08) -------------------------------------------------------------------------

  async settings(): Promise<ConsoleSettings> {
    return readConsoleSettings(this.db);
  }

  async updateSettings(
    actor: ConsoleActor,
    input: {
      maintenanceBanner?: string | null | undefined;
      supportMaxHours?: number | undefined;
      reason: string;
    },
  ): Promise<ConsoleSettings> {
    const before = await this.settings();
    await this.db.runPlatform(async (tx) => {
      const write = (key: string, value: unknown) =>
        tx.platformSetting.upsert({
          where: { key },
          create: { key, value: value as object },
          update: { value: value as object },
        });
      if (input.maintenanceBanner !== undefined)
        await write(MAINTENANCE_BANNER_KEY, input.maintenanceBanner ?? '');
      if (input.supportMaxHours !== undefined) await write(SUPPORT_MAX_KEY, input.supportMaxHours);
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'console.settings_updated',
        entityType: 'platform_setting',
        before: before as never,
        after: input as never,
      });
    });
    return this.settings();
  }

  // --- Audit (S-C09) ---------------------------------------------------------------------------------

  async audit(query: {
    tenantId?: string | undefined;
    action?: string | undefined;
    actorId?: string | undefined;
    before?: number | undefined;
  }): Promise<ConsoleAuditPage> {
    return this.db.runPlatform(async (tx) => {
      const where: Prisma.PlatformAuditLogWhereInput = {
        ...(query.tenantId !== undefined && { tenantRef: query.tenantId }),
        ...(query.action !== undefined && { action: { startsWith: query.action } }),
        ...(query.actorId !== undefined && { actorId: query.actorId }),
        ...(query.before !== undefined && { id: { lt: BigInt(query.before) } }),
      };
      const rows = await tx.platformAuditLog.findMany({ where, orderBy: { id: 'desc' }, take: 51 });
      const page = rows.slice(0, 50);
      const actors = await tx.platformUser.findMany({
        where: {
          id: { in: [...new Set(page.map((r) => r.actorId).filter((id): id is string => id !== null))] },
        },
        select: { id: true, displayName: true },
      });
      const names = new Map(actors.map((a) => [a.id, a.displayName]));
      return {
        entries: page.map((row) => ({
          id: row.id.toString(),
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          tenantId: row.tenantRef,
          actorName: row.actorId === null ? null : (names.get(row.actorId) ?? null),
          before: row.before ?? null,
          after: row.after ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
        nextBefore: rows.length > 50 ? (page[page.length - 1]?.id.toString() ?? null) : null,
      };
    });
  }

  // --- Overview, metrics, provider health (S-C02) --------------------------------------------------------

  async overview(): Promise<ConsoleOverview> {
    return this.db.runPlatform(async (tx) => {
      const grouped = await tx.tenant.groupBy({ by: ['status'], _count: { _all: true } });
      const tenantsByStatus = { PROVISIONING: 0, ACTIVE: 0, SUSPENDED: 0, OFFBOARDING: 0, DELETED: 0 };
      for (const row of grouped) tenantsByStatus[row.status] = row._count._all;
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const newThisMonth = await tx.tenant.count({ where: { createdAt: { gte: monthStart } } });
      const tenants = await tx.tenant.findMany({
        where: { status: { in: ['ACTIVE', 'PROVISIONING', 'SUSPENDED'] } },
        select: {
          id: true,
          name: true,
          plan: { select: { id: true, code: true, name: true, features: true, limits: true, pricing: true } },
        },
      });
      const latest = await latestUsage(
        tx,
        tenants.map((t) => t.id),
      );
      const nearLimits: ConsoleOverview['nearLimits'] = [];
      for (const tenant of tenants) {
        const usage = latest.get(tenant.id);
        if (usage === undefined) continue;
        const limits = planFromRow(tenant.plan).limits;
        const learners = meterPercent(usage.activeLearners, limits.maxActiveLearners);
        const storage = meterPercent(Number(usage.storageBytes), limitOf(limits, 'storage'));
        if (learners !== null && learners >= 80)
          nearLimits.push({
            tenantId: tenant.id,
            name: tenant.name,
            meter: 'activeLearners',
            percent: learners,
          });
        if (storage !== null && storage >= 80)
          nearLimits.push({ tenantId: tenant.id, name: tenant.name, meter: 'storage', percent: storage });
      }
      return {
        tenantsByStatus,
        newThisMonth,
        nearLimits: nearLimits.sort((a, b) => b.percent - a.percent).slice(0, 20),
        pendingDomainRequests: await tx.domainChangeRequest.count({ where: { status: 'REQUESTED' } }),
        pendingSupportRequests: await tx.supportAccessGrant.count({ where: { status: 'REQUESTED' } }),
        providers: (await this.health()).providers,
      };
    });
  }

  /** Aggregates over the latest usage rows: counts and sums only (F43). */
  async metrics(): Promise<ConsoleMetrics> {
    return this.db.runPlatform(async (tx) => {
      const tenants = await tx.tenant.findMany({
        where: { status: { not: 'DELETED' } },
        select: { id: true },
      });
      const latest = [
        ...(
          await latestUsage(
            tx,
            tenants.map((t) => t.id),
          )
        ).values(),
      ];
      const since = new Date(Date.now() - 30 * 86_400_000);
      const recent = await tx.tenantUsageDaily.aggregate({
        where: { date: { gte: since } },
        _sum: { paymentsCount: true, paymentsAmountMinor: true, emailsSent: true },
      });
      const instructors = await tx.tenantUsageDaily.findMany({
        where: { tenantId: { in: tenants.map((t) => t.id) } },
        orderBy: { date: 'desc' },
        distinct: ['tenantId'],
        select: { instructors: true },
      });
      return {
        tenants: tenants.length,
        activeLearners: latest.reduce((total, row) => total + row.activeLearners, 0),
        instructors: instructors.reduce((total, row) => total + row.instructors, 0),
        storageBytes: latest.reduce((total, row) => total + Number(row.storageBytes), 0),
        paymentsLast30Days: {
          count: recent._sum.paymentsCount ?? 0,
          amountMinor: Number(recent._sum.paymentsAmountMinor ?? 0n),
        },
        emailsLast30Days: recent._sum.emailsSent ?? 0,
      };
    });
  }

  /**
   * Provider health (S-C08): payments and video are the fake adapters until providers are approved.
   * Email and storage report UNKNOWN until the production providers (and their status APIs) are chosen.
   */
  async health(): Promise<ProviderHealth> {
    const payments = this.config.get('PAYMENT_PROVIDERS');
    const database = await this.prisma.isReachable(2000);
    return {
      providers: [
        {
          kind: 'payments',
          name: payments.join(', '),
          status: 'OK',
          detail: 'Fake adapter only (no provider approved yet, Q-PAY-3)',
        },
        {
          kind: 'video',
          name: this.config.get('VIDEO_PROVIDER'),
          status: 'OK',
          detail: 'Fake adapter (development)',
        },
        {
          kind: 'email',
          name: 'SMTP',
          status: database ? 'UNKNOWN' : 'DOWN',
          detail: 'Delivery is retried by the worker for 24 hours',
        },
        { kind: 'storage', name: 'S3-compatible', status: 'UNKNOWN', detail: null },
      ],
    };
  }

  paymentProviders() {
    return {
      providers: this.config.get('PAYMENT_PROVIDERS').map((name) => ({
        name,
        approved: false,
        note: 'Development adapter. A real provider needs written client approval (Q-PAY-3).',
      })),
    };
  }
}

export async function readConsoleSettings(db: TenantDb): Promise<ConsoleSettings> {
  return db.runPlatform(async (tx: TenantTx) => {
    const rows = await tx.platformSetting.findMany({
      where: { key: { in: [MAINTENANCE_BANNER_KEY, SUPPORT_MAX_KEY] } },
    });
    const value = (key: string) => rows.find((row) => row.key === key)?.value;
    const banner = value(MAINTENANCE_BANNER_KEY);
    const hours = value(SUPPORT_MAX_KEY);
    return {
      maintenanceBanner: typeof banner === 'string' && banner.trim() !== '' ? banner : null,
      supportMaxHours: typeof hours === 'number' ? hours : DEFAULT_CONSOLE_SETTINGS.supportMaxHours,
    };
  });
}

function toPlan(
  plan: {
    id: string;
    code: string;
    name: string;
    features: unknown;
    limits: unknown;
    pricing: unknown;
    isPublic: boolean;
    status: 'ACTIVE' | 'RETIRED';
    version: number;
  },
  tenantCount: number,
): ConsolePlan {
  const parsed = planFromRow(plan);
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    features: parsed.features ?? {},
    limits: parsed.limits,
    pricing: parsed.pricing,
    isPublic: plan.isPublic,
    status: plan.status,
    tenantCount,
    version: plan.version,
  };
}
