import { CONTENT_SETTING_KEYS, type ContentSettings, contentSettingsFrom } from '@studyhub/contracts';

import type { TenantTx } from '../../platform';

/** The current school's content settings (BR-56, BR-57, BR-64), defaults for missing keys. */
export async function readContentSettings(tx: TenantTx): Promise<ContentSettings> {
  const rows = await tx.tenantSetting.findMany({
    where: { key: { in: CONTENT_SETTING_KEYS } },
    select: { key: true, value: true },
  });
  return contentSettingsFrom(rows);
}
