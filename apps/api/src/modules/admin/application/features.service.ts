import { Injectable } from '@nestjs/common';
import {
  type AdminFeatures,
  type AdminLocales,
  DEFAULT_LOCALE_SETTINGS,
  FEATURE_KEYS,
  type FeatureKey,
  SUPPORTED_LOCALES,
  tenantLocaleSettingsSchema,
} from '@studyhub/contracts';

import { AuditService } from '../../audit';
import type { TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import {
  featureAvailable,
  featureChangeProblems,
  featureMap,
  LATER_FEATURES,
  planGrants,
  readPlan,
  TENANT_SWITCH_DEFAULTS,
} from '../../tenancy';
import { requireAdmin } from './guards';

/** Features (F40, S-AD13) and languages (BR-61) of a school. */
@Injectable()
export class FeaturesService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(actor: TenantActor): Promise<AdminFeatures> {
    requireAdmin(actor);
    return this.db.run((tx) => this.read(tx));
  }

  /** A school switches a feature within its plan; switching off keeps the data (F40 AC 1, AC 2). */
  async set(actor: TenantActor, key: FeatureKey, enabled: boolean): Promise<void> {
    requireAdmin(actor);
    await this.db.run(async (tx) => {
      const tenantId = requireTenantId();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`features:${tenantId}`}))`;
      const features = await this.read(tx);
      const feature = features.features.find((f) => f.key === key);
      if (feature === undefined) throw new AppError('NOT_FOUND');
      if (enabled && (!feature.available || feature.later)) {
        throw new AppError('FEATURE_NOT_ENABLED', {
          detail: 'This feature is not in your plan. Contact the platform team to add it.',
          extensions: { feature: key },
        });
      }
      const current = Object.fromEntries(features.features.map((f) => [f.key, f.effective]));
      const problems = featureChangeProblems(current as Record<FeatureKey, boolean>, key, enabled);
      if (problems.length > 0) {
        throw new AppError('VALIDATION_FAILED', {
          errors: problems.map((problem) => ({
            field: 'enabled',
            code: problem.code,
            message:
              problem.code === 'dependency_disabled'
                ? `Enable ${problem.feature} before enabling ${key}.`
                : `Disable ${problem.feature} before disabling ${key}.`,
          })),
        });
      }
      if (feature.enabledByTenant === enabled) return;
      await tx.tenantFeature.upsert({
        where: { tenantId_featureKey: { tenantId, featureKey: key } },
        create: { tenantId, featureKey: key, enabledByTenant: enabled, updatedBy: actor.membershipId },
        update: { enabledByTenant: enabled, updatedBy: actor.membershipId, updatedAt: new Date() },
      });
      await this.audit.record(tx, {
        action: 'feature.switched',
        entityType: 'tenant_feature',
        entityId: key,
        actorId: actor.userId,
        before: { enabled: feature.enabledByTenant },
        after: { enabled },
      });
    });
  }

  async locales(actor: TenantActor): Promise<AdminLocales> {
    requireAdmin(actor);
    return this.db.run(async (tx) => ({ available: [...SUPPORTED_LOCALES], ...(await readLocales(tx)) }));
  }

  /** BR-61: users whose language is switched off fall back to the default (resolved at render time). */
  async setLocales(
    actor: TenantActor,
    input: { defaultLocale: string; enabledLocales: string[]; timeZone: string; reason: string },
  ): Promise<void> {
    requireAdmin(actor);
    await this.db.run(async (tx) => {
      const before = await readLocales(tx);
      const tenantId = requireTenantId();
      const now = new Date();
      for (const key of ['defaultLocale', 'enabledLocales', 'timeZone'] as const) {
        const value = input[key] as object;
        await tx.tenantSetting.upsert({
          where: { tenantId_key: { tenantId, key } },
          create: { tenantId, key, value, updatedBy: actor.membershipId, updatedAt: now },
          update: { value, updatedBy: actor.membershipId, updatedAt: now },
        });
      }
      await this.audit.record(tx, {
        action: 'settings.locales_updated',
        entityType: 'tenant_setting',
        actorId: actor.userId,
        before,
        after: {
          defaultLocale: input.defaultLocale,
          enabledLocales: input.enabledLocales,
          timeZone: input.timeZone,
          reason: input.reason,
        },
      });
    });
  }

  private async read(tx: TenantTx): Promise<AdminFeatures> {
    const rows = await tx.tenantFeature.findMany({
      select: { featureKey: true, enabledByTenant: true, platformOverride: true },
    });
    const plan = await readPlan(tx);
    const effective = featureMap(rows, plan.features);
    const byKey = new Map(rows.map((row) => [row.featureKey, row]));
    return {
      features: FEATURE_KEYS.map((key) => {
        const row = byKey.get(key) ?? null;
        const grants = planGrants(plan.features, key);
        return {
          key,
          available: featureAvailable(row, grants),
          planGrants: grants,
          override: row?.platformOverride ?? 'NONE',
          enabledByTenant: row?.enabledByTenant ?? TENANT_SWITCH_DEFAULTS[key] ?? true,
          effective: effective[key],
          later: LATER_FEATURES.has(key),
        };
      }),
    };
  }
}

async function readLocales(tx: TenantTx) {
  const rows = await tx.tenantSetting.findMany({
    where: { key: { in: ['defaultLocale', 'enabledLocales', 'timeZone'] } },
    select: { key: true, value: true },
  });
  const merged = tenantLocaleSettingsSchema.safeParse({
    ...DEFAULT_LOCALE_SETTINGS,
    ...Object.fromEntries(rows.map((row) => [row.key, row.value])),
  });
  return merged.success ? merged.data : DEFAULT_LOCALE_SETTINGS;
}
