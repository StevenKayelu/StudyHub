import { FEATURE_KEYS, type FeatureKey, type FeatureMap } from '@studyhub/contracts';

export interface FeatureRow {
  featureKey: string;
  enabledByTenant: boolean;
  platformOverride: 'NONE' | 'GRANT' | 'REVOKE';
}

/** The features a plan grants: key → bool; a missing key is not granted. null: no plan assigned. */
export type PlanGrants = Partial<Record<FeatureKey, boolean>> | null;

/**
 * A school's own switch when it has never set one. Instructor revenue share is off by default: most
 * schools pay their staff salaries and keep their sales (03 §9.2 F29; M8 PROPOSED).
 */
export const TENANT_SWITCH_DEFAULTS: Readonly<Partial<Record<FeatureKey, boolean>>> = {
  instructorRevenueShare: false,
};

/** Features specified but not built yet (03 F38 custom domains, certificates): never effective. */
export const LATER_FEATURES: ReadonlySet<FeatureKey> = new Set<FeatureKey>(['customDomain', 'certificates']);

/** Dependencies apply to configuration changes; historic payments and ledger entries keep working. */
export const FEATURE_DEPENDENCIES: Readonly<Partial<Record<FeatureKey, readonly FeatureKey[]>>> = {
  instructorRevenueShare: ['paidCourses'],
};

export function featureChangeProblems(
  current: FeatureMap,
  key: FeatureKey,
  enabled: boolean,
): { feature: FeatureKey; code: 'dependency_disabled' | 'dependent_enabled' }[] {
  if (enabled) {
    return (FEATURE_DEPENDENCIES[key] ?? [])
      .filter((dependency) => !current[dependency])
      .map((feature) => ({ feature, code: 'dependency_disabled' }));
  }
  return FEATURE_KEYS.filter(
    (dependent) => current[dependent] && FEATURE_DEPENDENCIES[dependent]?.includes(key),
  ).map((feature) => ({ feature, code: 'dependent_enabled' }));
}

/** Whether the plan grants a feature. A school without a plan keeps every feature (M7/M8 behaviour). */
export function planGrants(plan: PlanGrants, key: FeatureKey): boolean {
  return plan === null ? true : plan[key] === true;
}

/**
 * BR-48: effective = (the plan grants it, or the platform grants it) AND the school has it switched on,
 * unless the platform revokes it.
 */
export function featureEnabled(
  row: Omit<FeatureRow, 'featureKey'> | null,
  grantedByPlan = true,
  switchDefault = true,
): boolean {
  const override = row?.platformOverride ?? 'NONE';
  if (override === 'REVOKE') return false;
  const granted = override === 'GRANT' || grantedByPlan;
  return granted && (row?.enabledByTenant ?? switchDefault);
}

/** Whether the school may switch the feature on at all (S-AD13 "Included" / "Not in your plan"). */
export function featureAvailable(
  row: Omit<FeatureRow, 'featureKey'> | null,
  grantedByPlan: boolean,
): boolean {
  const override = row?.platformOverride ?? 'NONE';
  return override !== 'REVOKE' && (override === 'GRANT' || grantedByPlan);
}

/** Every feature key with its effective state. */
export function featureMap(rows: readonly FeatureRow[], plan: PlanGrants = null): FeatureMap {
  const byKey = new Map(rows.map((row) => [row.featureKey, row]));
  return Object.fromEntries(
    FEATURE_KEYS.map((key: FeatureKey) => [
      key,
      !LATER_FEATURES.has(key) &&
        featureEnabled(byKey.get(key) ?? null, planGrants(plan, key), TENANT_SWITCH_DEFAULTS[key] ?? true),
    ]),
  ) as FeatureMap;
}
