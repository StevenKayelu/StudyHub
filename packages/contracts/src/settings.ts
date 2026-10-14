import { z } from 'zod';

/**
 * Typed school settings used from M5 and M6 (blueprint 05 §8.2 tenant_setting; BR-56, BR-57, BR-64). Each key
 * is stored as its own tenant_setting row; missing keys take these defaults. The settings screen
 * (S-AD09) arrives with tenant administration; until then the defaults (or seeded values) apply.
 */

/** Document types a school may allow for lesson files (subset of the platform allowlist). */
export const DOCUMENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const contentSettingsSchema = z.object({
  /** BR-56: how instructors join. */
  instructorOnboardingMode: z.enum(['INVITE_ONLY', 'APPLICATION']).default('INVITE_ONLY'),
  /** BR-05: first publication needs an administrator's approval. */
  courseReviewRequired: z.boolean().default(true),
  /** BR-57: who sees the catalogue. */
  catalogVisibility: z.enum(['PUBLIC', 'MEMBERS_ONLY']).default('PUBLIC'),
  /** BR-64: defaults and limits for new content. */
  allowedUploadTypes: z.array(z.enum(DOCUMENT_TYPES)).default([...DOCUMENT_TYPES]),
  maxDocumentMb: z.number().int().min(1).max(500).default(50),
  maxVideoGb: z.number().min(0.1).max(20).default(4),
  downloadsAllowedDefault: z.boolean().default(false),
  /** BR-64 / M6: a video lesson completes at this share of its duration. */
  videoCompletionThresholdPct: z.number().int().min(50).max(100).default(90),
  /** BR-12: access length for courses that don't set their own (null: lifetime). */
  defaultAccessDays: z.number().int().min(1).max(3650).nullable().default(null),
  /** Commerce (BR-04): minimum price of a paid course, in minor units. */
  minPaidPriceMinor: z.number().int().min(0).default(1000),
});
export type ContentSettings = z.infer<typeof contentSettingsSchema>;

export const CONTENT_SETTING_KEYS = Object.keys(contentSettingsSchema.shape) as (keyof ContentSettings)[];

/**
 * Settings from stored rows: each value is validated on its own, so one bad row falls back to its
 * default instead of discarding the rest.
 */
export function contentSettingsFrom(rows: { key: string; value: unknown }[]): ContentSettings {
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    const field = (contentSettingsSchema.shape as Record<string, z.ZodType>)[row.key];
    if (field !== undefined && field.safeParse(row.value).success) values[row.key] = row.value;
  }
  return contentSettingsSchema.parse(values);
}
