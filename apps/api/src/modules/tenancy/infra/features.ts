import type { FeatureKey, FeatureMap } from '@studyhub/contracts';

import { AppError, type TenantTx } from '../../platform';
import { featureMap } from '../domain/features';
import { readPlan } from './plans';

/** The current school's effective features (F40, BR-48): plan grants, platform overrides, its switches. */
export async function readFeatures(tx: TenantTx): Promise<FeatureMap> {
  const rows = await tx.tenantFeature.findMany({
    select: { featureKey: true, enabledByTenant: true, platformOverride: true },
  });
  return featureMap(rows, (await readPlan(tx)).features);
}

/** F40 AC 1: a switched-off feature's endpoints answer 403 FEATURE_NOT_ENABLED; its data is kept. */
export async function requireFeature(tx: TenantTx, key: FeatureKey): Promise<void> {
  if (!(await readFeatures(tx))[key]) {
    throw new AppError('FEATURE_NOT_ENABLED', { extensions: { feature: key } });
  }
}
