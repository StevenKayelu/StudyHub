import { COMMERCE_SETTING_KEYS, type CommerceSettings, commerceSettingsFrom } from '@studyhub/contracts';

import type { TenantTx } from '../../platform';

/** The current school's commerce settings (M8, BR-62); missing keys take their defaults. */
export async function readCommerceSettings(tx: TenantTx): Promise<CommerceSettings> {
  const rows = await tx.tenantSetting.findMany({
    where: { key: { in: COMMERCE_SETTING_KEYS } },
    select: { key: true, value: true },
  });
  return commerceSettingsFrom(rows);
}
