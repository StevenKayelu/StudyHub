import { FEATURE_KEYS, type FeatureKey, type FeatureMap } from '@studyhub/contracts';

export interface FeatureRow {
  featureKey: string;
  enabledByTenant: boolean;
  platformOverride: 'NONE' | 'GRANT' | 'REVOKE';
}

/**
 * A school's own switch when it has never set one. Instructor revenue share is off by default: most
 * schools pay their staff salaries and keep their sales (03 §9.2 F29; M8 PROPOSED).
 */
export const TENANT_SWITCH_DEFAULTS: Readonly<Partial<Record<FeatureKey, boolean>>> = {
  instructorRevenueShare: false,
};

/**
 * BR-48: effective = (the plan grants it, or the platform grants it) AND the school has it switched on,
 * unless the platform revokes it. Plans arrive with M9: until then the plan grants every feature
 * (PROPOSED), and a school's own switch defaults to on (except TENANT_SWITCH_DEFAULTS).
 */
export function featureEnabled(
  row: Omit<FeatureRow, 'featureKey'> | null,
  planGrants = true,
  switchDefault = true,
): boolean {
  const override = row?.platformOverride ?? 'NONE';
  if (override === 'REVOKE') return false;
  const granted = override === 'GRANT' || planGrants;
  return granted && (row?.enabledByTenant ?? switchDefault);
}

/** Every feature key with its effective state. */
export function featureMap(rows: readonly FeatureRow[]): FeatureMap {
  const byKey = new Map(rows.map((row) => [row.featureKey, row]));
  return Object.fromEntries(
    FEATURE_KEYS.map((key: FeatureKey) => [
      key,
      featureEnabled(byKey.get(key) ?? null, true, TENANT_SWITCH_DEFAULTS[key] ?? true),
    ]),
  ) as FeatureMap;
}
