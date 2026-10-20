import { z } from 'zod';

import { contentSettingsSchema } from './settings';

/** Phase 1 deliberately exposes only implemented content controls. No infrastructure secrets. */
export const MANAGED_CONTENT_KEYS = [
  'catalogVisibility',
  'courseReviewRequired',
  'downloadsAllowedDefault',
] as const;
export const managedContentKeySchema = z.enum(MANAGED_CONTENT_KEYS);
export type ManagedContentKey = z.infer<typeof managedContentKeySchema>;
export const managedContentValuesSchema = z
  .object({
    catalogVisibility: contentSettingsSchema.shape.catalogVisibility.unwrap().optional(),
    courseReviewRequired: contentSettingsSchema.shape.courseReviewRequired.unwrap().optional(),
    downloadsAllowedDefault: contentSettingsSchema.shape.downloadsAllowedDefault.unwrap().optional(),
  })
  .strict();
export type ManagedContentValues = z.infer<typeof managedContentValuesSchema>;

export const MANAGED_CONTENT_DESCRIPTIONS: Record<ManagedContentKey, string> = {
  catalogVisibility:
    'Catalogue visibility for visitors. Public access also requires the public catalogue feature. Member access and enrolments still apply.',
  courseReviewRequired: 'Require administrator review on the next course submission.',
  downloadsAllowedDefault: 'Default copied to new lessons. Existing lessons keep their download setting.',
};
export const MANAGED_CONTENT_LABELS: Record<ManagedContentKey, string> = {
  catalogVisibility: 'Catalogue visibility',
  courseReviewRequired: 'Course review required',
  downloadsAllowedDefault: 'Allow downloads on new lessons',
};

/** Version 1 JSON envelopes; future versions require an explicit reader/migration, never a cast. */
export const contentDefaultsDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    values: managedContentValuesSchema,
    lockedKeys: z.array(managedContentKeySchema).max(MANAGED_CONTENT_KEYS.length),
  })
  .strict();
export type ContentDefaultsDocument = z.infer<typeof contentDefaultsDocumentSchema>;

const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const configurationDraftRequestSchema = z
  .object({
    expectedRevision: revision,
    values: managedContentValuesSchema,
    lockedKeys: z.array(managedContentKeySchema).max(MANAGED_CONTENT_KEYS.length).default([]),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export type ConfigurationDraftRequest = z.infer<typeof configurationDraftRequestSchema>;
export const configurationDraftSchema = configurationDraftRequestSchema
  .omit({ expectedRevision: true })
  .extend({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    baseRevision: revision,
    createdAt: z.iso.datetime(),
  });
export type ConfigurationDraft = z.infer<typeof configurationDraftSchema>;
export const configurationActivateRequestSchema = z
  .object({ draftId: z.uuid(), expectedRevision: revision })
  .strict();
export type ConfigurationActivateRequest = z.infer<typeof configurationActivateRequestSchema>;

export const configurationViewSchema = z.object({
  schemaVersion: z.literal(1),
  scope: z.enum(['PLATFORM', 'SCHOOL']),
  revision,
  values: managedContentValuesSchema,
  lockedKeys: z.array(managedContentKeySchema),
  fields: z.array(
    z.object({
      key: managedContentKeySchema,
      value: z.union([z.boolean(), z.string()]),
      inheritedValue: z.union([z.boolean(), z.string()]),
      overrideValue: z.union([z.boolean(), z.string()]).nullable(),
      source: z.enum(['PLATFORM_DEFAULT', 'SCHOOL_OVERRIDE', 'PLATFORM_ENFORCED']),
      locked: z.boolean(),
      effect: z.enum(['NEXT_REQUEST', 'NEW_CONTENT']),
    }),
  ),
  draft: configurationDraftSchema.extend({ stale: z.boolean() }).nullable(),
  history: z.array(
    z.object({
      id: z.string(),
      at: z.iso.datetime(),
      actorId: z.string().nullable(),
      reason: z.string(),
      values: managedContentValuesSchema,
      lockedKeys: z.array(managedContentKeySchema),
    }),
  ),
});
export type ConfigurationView = z.infer<typeof configurationViewSchema>;

export const configurationImportRequestSchema = z.object({ text: z.string().max(32_768) }).strict();
export const configurationImportPreviewSchema = z.object({
  schemaVersion: z.literal(1),
  values: managedContentValuesSchema,
  entries: z.array(z.object({ key: z.string(), setting: managedContentKeySchema, displayValue: z.string() })),
});
export type ConfigurationImportPreview = z.infer<typeof configurationImportPreviewSchema>;
