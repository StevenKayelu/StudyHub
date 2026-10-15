import { FEATURE_KEYS, type FeatureKey, type FeatureMap } from '@studyhub/contracts';

export interface FeatureRow {
  featureKey: string;
  enabledByTenant: boolean;
  platformOverride: 'NONE' | 'GRANT' | 'REVOKE';
}

/**
 * BR-48: effective = (the plan grants it, or the platform grants it) AND the school has it switched on,
 * unless the platform revokes it. Plans arrive with M9: until then the plan grants every feature
 * (PROPOSED), and a school's own switch defaults to on.
 */
export function featureEnabled(row: Omit<FeatureRow, 'featureKey'> | null, planGrants = true): boolean {
  const override = row?.platformOverride ?? 'NONE';
  if (override === 'REVOKE') return false;
  const granted = override === 'GRANT' || planGrants;
  return granted && (row?.enabledByTenant ?? true);
}

/** Every feature key with its effective state. */
export function featureMap(rows: readonly FeatureRow[]): FeatureMap {
  const byKey = new Map(rows.map((row) => [row.featureKey, row]));
  return Object.fromEntries(
    FEATURE_KEYS.map((key: FeatureKey) => [key, featureEnabled(byKey.get(key) ?? null)]),
  ) as FeatureMap;
}
