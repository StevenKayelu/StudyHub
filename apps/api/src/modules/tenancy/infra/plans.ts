import {
  DEFAULT_PLAN_LIMITS,
  type PlanFeatures,
  planFeaturesSchema,
  type PlanLimits,
  type PlanPricing,
  planPricingSchema,
} from '@studyhub/contracts';

import { AppError, queueEmail, requireTenantId, type SecretBox, type TenantTx } from '../../platform';
import { crossedLevel, type LimitKind, limitOf, limitsFrom, wouldExceed } from '../domain/limits';

export interface EffectivePlan {
  /** null: the school has no plan yet (every feature granted, default limits). */
  id: string | null;
  code: string;
  name: string;
  features: PlanFeatures | null;
  limits: PlanLimits;
  pricing: PlanPricing;
}

const NO_PLAN_PRICING: PlanPricing = { subscriptionFeeMinor: 0, currency: 'ZMW', platformCommissionBps: 0 };

/**
 * A school with no plan yet (existing schools before M9, CLI-provisioned schools) keeps the pre-plan
 * behaviour: no member limits; storage falls back to DEFAULT_STORAGE_QUOTA_MB in the media module.
 */
const NO_PLAN_LIMITS: PlanLimits = {
  ...DEFAULT_PLAN_LIMITS,
  maxActiveLearners: null,
  maxInstructors: null,
  maxAdmins: null,
  videoMinutesPerMonth: null,
};

export function planFromRow(
  row: {
    id: string;
    code: string;
    name: string;
    features: unknown;
    limits: unknown;
    pricing: unknown;
  } | null,
): EffectivePlan {
  if (row === null) {
    return {
      id: null,
      code: 'none',
      name: 'No plan',
      features: null,
      limits: NO_PLAN_LIMITS,
      pricing: NO_PLAN_PRICING,
    };
  }
  const features = planFeaturesSchema.safeParse(row.features);
  const pricing = planPricingSchema.safeParse(row.pricing);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    features: features.success ? features.data : {},
    limits: limitsFrom(row.limits),
    pricing: pricing.success ? pricing.data : NO_PLAN_PRICING,
  };
}

/** The current school's plan (the plan table is readable by every school; it holds no school data). */
export async function readPlan(tx: TenantTx): Promise<EffectivePlan> {
  const tenant = await tx.tenant.findFirst({
    select: {
      plan: { select: { id: true, code: true, name: true, features: true, limits: true, pricing: true } },
    },
  });
  return planFromRow(tenant?.plan ?? null);
}

/** Current usage of one limit kind in the current school (bytes for storage). */
export async function countUsage(tx: TenantTx, kind: LimitKind, includeInvitations = false): Promise<number> {
  if (kind === 'storage') {
    const usage = await tx.tenantUsage.findFirst({ select: { storageBytes: true, reservedBytes: true } });
    return Number((usage?.storageBytes ?? 0n) + (usage?.reservedBytes ?? 0n));
  }
  // Every member holds the learner role; an "active learner" is a member with no staff role.
  if (kind === 'activeLearners') {
    return tx.tenantMembership.count({
      where: {
        status: 'ACTIVE',
        roles: { none: { role: { in: ['INSTRUCTOR', 'TENANT_ADMIN', 'TENANT_OWNER'] } } },
      },
    });
  }
  const roles =
    kind === 'instructors' ? (['INSTRUCTOR'] as const) : (['TENANT_ADMIN', 'TENANT_OWNER'] as const);
  const members = await tx.tenantMembership.count({
    where: { status: 'ACTIVE', roles: { some: { role: { in: [...roles] } } } },
  });
  if (!includeInvitations) return members;
  const invitations = await tx.invitation.count({
    where: { role: { in: [...roles] }, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
  });
  return members + invitations;
}

const KIND_LABELS: Record<LimitKind, string> = {
  activeLearners: 'active learners',
  instructors: 'instructors',
  admins: 'administrators',
  storage: 'storage',
};

/**
 * BR-49: refuses an action that would take the school over its plan limit, with `409 LIMIT_REACHED`.
 * Serialised per school and kind with a transaction-scoped advisory lock, so two concurrent invitations
 * can't both take the last seat. Warns the owners when the action crosses 80 % or 100 %.
 */
export async function enforceLimit(
  tx: TenantTx,
  kind: LimitKind,
  options: { adding?: number; box?: SecretBox; includeInvitations?: boolean } = {},
): Promise<void> {
  const tenantId = requireTenantId();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`limit:${tenantId}:${kind}`}))`;
  const plan = await readPlan(tx);
  const limit = limitOf(plan.limits, kind);
  if (limit === null) return;
  const adding = options.adding ?? 1;
  const used = await countUsage(tx, kind, options.includeInvitations ?? kind !== 'activeLearners');
  if (wouldExceed(used, adding, limit)) {
    throw new AppError('LIMIT_REACHED', {
      detail: `Your plan allows ${kind === 'storage' ? `${plan.limits.storageGb} GB of storage` : `${limit} ${KIND_LABELS[kind]}`}. Ask the platform about a larger plan.`,
      extensions: { limit: kind, max: limit },
    });
  }
  if (options.box !== undefined) await noteUsageLevel(tx, options.box, kind, used, used + adding, limit);
}

/**
 * Emails the owners once per month and level when usage crosses 80 % or 100 % of a limit (F40 AC 3).
 * The levels already reported are kept in the `usageAlerts` setting.
 */
export async function noteUsageLevel(
  tx: TenantTx,
  box: SecretBox,
  kind: LimitKind,
  before: number,
  after: number,
  limit: number | null,
): Promise<void> {
  const level = crossedLevel(before, after, limit);
  if (level === null) return;
  const month = new Date().toISOString().slice(0, 7);
  const key = `${month}:${kind}:${level}`;
  const stored = await tx.tenantSetting.findFirst({ where: { key: 'usageAlerts' }, select: { value: true } });
  const sent = Array.isArray(stored?.value)
    ? (stored.value as unknown[]).filter((v) => typeof v === 'string')
    : [];
  if (sent.includes(key)) return;
  const tenantId = requireTenantId();
  await tx.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key: 'usageAlerts' } },
    create: { tenantId, key: 'usageAlerts', value: [...sent.slice(-50), key] },
    update: { value: [...sent.slice(-50), key], updatedAt: new Date() },
  });
  const school = await tx.tenantBranding.findFirst({ select: { displayName: true } });
  for (const owner of await ownerContacts(tx)) {
    await queueEmail(tx, box, {
      template: 'usage-alert',
      to: owner.email,
      vars: {
        schoolName: school?.displayName ?? 'Your school',
        displayName: owner.displayName,
        meter: KIND_LABELS[kind],
        level: String(level),
      },
    });
  }
}

/** The school's active owners (for lifecycle and limit emails). Names and emails never leave the school. */
export async function ownerContacts(tx: TenantTx): Promise<{ email: string; displayName: string }[]> {
  const owners = await tx.tenantMembership.findMany({
    where: { status: 'ACTIVE', roles: { some: { role: 'TENANT_OWNER' } } },
    select: { displayNameOverride: true, user: { select: { email: true, displayName: true } } },
  });
  return owners.map((o) => ({
    email: o.user.email,
    displayName: o.displayNameOverride ?? o.user.displayName,
  }));
}
