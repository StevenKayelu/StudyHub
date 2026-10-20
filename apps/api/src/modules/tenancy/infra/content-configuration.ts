import {
  contentDefaultsDocumentSchema,
  contentSettingsSchema,
  MANAGED_CONTENT_KEYS,
  type ContentDefaultsDocument,
  type ContentSettings,
  type ManagedContentValues,
  managedContentValuesSchema,
} from '@studyhub/contracts';

import { AppError, requireTenantId, type TenantTx } from '../../platform';

export const CONTENT_DEFAULTS_KEY = 'configuration.contentDefaults';
export const CONTENT_DRAFT_KEY = 'configurationContentDraft';
export const CONTENT_CONFIG_ACTION = 'configuration.activated';
export const CONTENT_CONFIG_ENTITY = 'content_configuration';
export const EMPTY_CONTENT_DEFAULTS: ContentDefaultsDocument = {
  schemaVersion: 1,
  values: {},
  lockedKeys: [],
};

/** Global document contains public policy only. Credentials never belong in platform_setting. */
export async function readContentDefaults(tx: TenantTx): Promise<ContentDefaultsDocument> {
  const row = await tx.platformSetting.findUnique({ where: { key: CONTENT_DEFAULTS_KEY } });
  const parsed = contentDefaultsDocumentSchema.safeParse(row === null ? EMPTY_CONTENT_DEFAULTS : row.value);
  if (!parsed.success) {
    throw new AppError('SERVICE_UNAVAILABLE', {
      detail: 'Content configuration needs operator repair. Restore a valid schema version before retrying.',
    });
  }
  return parsed.data;
}

export function managedOverridesFrom(rows: { key: string; value: unknown }[]): ManagedContentValues {
  const values: Record<string, unknown> = {};
  for (const key of MANAGED_CONTENT_KEYS) {
    const row = rows.find((candidate) => candidate.key === key);
    if (row !== undefined) values[key] = row.value;
  }
  const parsed = managedContentValuesSchema.safeParse(values);
  if (!parsed.success) {
    throw new AppError('SERVICE_UNAVAILABLE', { detail: 'School content overrides need operator repair.' });
  }
  return parsed.data;
}

export function effectiveManagedContent(
  defaults: ContentDefaultsDocument,
  overrides: ManagedContentValues,
): Pick<ContentSettings, 'catalogVisibility' | 'courseReviewRequired' | 'downloadsAllowedDefault'> {
  const base = contentSettingsSchema.parse({});
  const effective = { ...base };
  for (const values of [defaults.values, overrides]) {
    for (const key of MANAGED_CONTENT_KEYS) {
      if (values[key] !== undefined) Object.assign(effective, { [key]: values[key] });
    }
  }
  for (const key of defaults.lockedKeys) {
    Object.assign(effective, { [key]: defaults.values[key] ?? base[key] });
  }
  return {
    catalogVisibility: effective.catalogVisibility,
    courseReviewRequired: effective.courseReviewRequired,
    downloadsAllowedDefault: effective.downloadsAllowedDefault,
  };
}

/** Shared with the legacy PATCH route; reads happen after acquiring these transaction locks. */
export async function lockContentConfiguration(tx: TenantTx, scope: 'PLATFORM' | 'SCHOOL'): Promise<void> {
  if (scope === 'PLATFORM') {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('configuration:content:platform', 0))`;
  } else {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('configuration:content:platform', 0))`;
    const key = `configuration:content:school:${requireTenantId()}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}
