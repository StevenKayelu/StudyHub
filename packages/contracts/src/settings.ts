import { z } from 'zod';

import { generalSettingsSchema, legalPagesSchema } from './admin';

/**
 * Typed school settings used from M5 to M7 (blueprint 05 §8.2 tenant_setting; BR-56, BR-57, BR-64). Each key
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
  /** BR-64 / M7: defaults for new quizzes (each quiz can change them). */
  quizDefaults: z
    .object({
      feedbackPolicy: z.enum(['IMMEDIATE', 'AFTER_CLOSE', 'NEVER']).default('IMMEDIATE'),
      attemptsAllowed: z.number().int().min(1).max(100).nullable().default(null),
      passMarkPercent: z.number().int().min(0).max(100).nullable().default(null),
      shuffleQuestions: z.boolean().default(false),
      shuffleOptions: z.boolean().default(false),
    })
    .default({
      feedbackPolicy: 'IMMEDIATE',
      attemptsAllowed: null,
      passMarkPercent: null,
      shuffleQuestions: false,
      shuffleOptions: false,
    }),
  /** BR-64 / M7: practice sessions (F22). */
  practiceDefaults: z
    .object({
      questionsPerSession: z.number().int().min(1).max(50).default(10),
      mistakesModeEnabled: z.boolean().default(true),
    })
    .default({ questionsPerSession: 10, mistakesModeEnabled: true }),
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

export const depositPlanRulesSchema = z.object({
  enabled: z.boolean(),
  minDepositPct: z.number().int().min(1).max(99),
  maxBalanceDays: z.number().int().min(1).max(365),
});
export type DepositPlanRules = z.infer<typeof depositPlanRulesSchema>;
export const DEPOSIT_PLAN_RULE_DEFAULTS: DepositPlanRules = {
  enabled: false,
  minDepositPct: 20,
  maxBalanceDays: 90,
};

/**
 * Commerce settings (M8; 05 §8.2 "Commerce", BR-62, Q-BIZ-2 defaults). `minPaidPriceMinor` stays in the
 * content settings above (the publish checklist reads it) and is editable with this group.
 */
export const commerceSettingsSchema = z.object({
  /** Offered at checkout only where the active payment account also supports them (BR-62). */
  enabledPaymentMethods: z.array(z.enum(['MOBILE_MONEY', 'CARD'])).default(['MOBILE_MONEY', 'CARD']),
  /** BR-08: an unpaid order expires after this many minutes. */
  orderExpiryMinutes: z.number().int().min(10).max(1440).default(30),
  /** BR-15: earnings become available after the refund window; also the refund guidance (F28). */
  refundWindowDays: z.number().int().min(0).max(90).default(7),
  /** `PROVIDER_API` only when the account has a refund API (BR-62); otherwise refunds are recorded. */
  refundMode: z.enum(['PROVIDER_API', 'MANUAL']).default('MANUAL'),
  /** BR-14 / BR-63: the share of an instructor's sale the school keeps (revenue share only). */
  instructorCommissionBps: z.number().int().min(0).max(10_000).default(2000),
  /** Shown to instructors; payouts are recorded by an administrator (W3). */
  payoutSchedule: z.enum(['WEEKLY', 'MONTHLY', 'ON_REQUEST']).default('MONTHLY'),
  /** F48 / Q-LEG-3: the seller on receipts. No tax is computed. */
  receiptSeller: z
    .object({
      legalName: z.string().trim().max(160).nullable().default(null),
      address: z.string().trim().max(400).nullable().default(null),
      taxId: z.string().trim().max(40).nullable().default(null),
    })
    .default({ legalName: null, address: null, taxId: null }) /**
   * Deposit plans (docs/design/payment-plans.md): whether tutors may offer "pay part now, the balance
   * later", the smallest deposit as a share of the price and the longest time allowed to pay the balance.
   */,
  depositPlans: depositPlanRulesSchema.default(DEPOSIT_PLAN_RULE_DEFAULTS),
});
export type CommerceSettings = z.infer<typeof commerceSettingsSchema>;

export const COMMERCE_SETTING_KEYS = Object.keys(commerceSettingsSchema.shape) as (keyof CommerceSettings)[];

export function commerceSettingsFrom(rows: { key: string; value: unknown }[]): CommerceSettings {
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    const field = (commerceSettingsSchema.shape as Record<string, z.ZodType>)[row.key];
    if (field !== undefined && field.safeParse(row.value).success) values[row.key] = row.value;
  }
  return commerceSettingsSchema.parse(values);
}

/**
 * PATCH /admin/settings (S-AD09): every group (M8 commerce, M9 learners, catalogue, instructors, courses
 * and materials, legal). Every change needs a reason; content settings are defaults for new content only
 * (BR-64), and upload sizes are capped by the plan.
 */
export const settingsPatchSchema = z
  .object({
    // Learners and catalogue (BR-02, BR-57)
    learnerRegistrationMode: generalSettingsSchema.shape.learnerRegistrationMode.unwrap().optional(),
    allowedEmailDomains: generalSettingsSchema.shape.allowedEmailDomains.unwrap().optional(),
    unverifiedFreeEnrolment: z.boolean().optional(),
    catalogVisibility: z.enum(['PUBLIC', 'MEMBERS_ONLY']).optional(),
    // Instructors and review (BR-05, BR-56)
    instructorOnboardingMode: z.enum(['INVITE_ONLY', 'APPLICATION']).optional(),
    courseReviewRequired: z.boolean().optional(),
    // Courses and materials (BR-64)
    allowedUploadTypes: z.array(z.enum(DOCUMENT_TYPES)).max(DOCUMENT_TYPES.length).optional(),
    maxDocumentMb: z.number().int().min(1).max(500).optional(),
    maxVideoGb: z.number().min(0.1).max(20).optional(),
    downloadsAllowedDefault: z.boolean().optional(),
    videoCompletionThresholdPct: z.number().int().min(50).max(100).optional(),
    defaultAccessDays: z.number().int().min(1).max(3650).nullable().optional(),
    quizDefaults: contentSettingsSchema.shape.quizDefaults.unwrap().optional(),
    practiceDefaults: contentSettingsSchema.shape.practiceDefaults.unwrap().optional(),
    // Legal pages, per enabled locale (F36 per school)
    legalPages: legalPagesSchema.optional(),
    // Commerce (M8)
    enabledPaymentMethods: z
      .array(z.enum(['MOBILE_MONEY', 'CARD']))
      .max(2)
      .optional(),
    orderExpiryMinutes: z.number().int().min(10).max(1440).optional(),
    refundWindowDays: z.number().int().min(0).max(90).optional(),
    refundMode: z.enum(['PROVIDER_API', 'MANUAL']).optional(),
    instructorCommissionBps: z.number().int().min(0).max(10_000).optional(),
    payoutSchedule: z.enum(['WEEKLY', 'MONTHLY', 'ON_REQUEST']).optional(),
    receiptSeller: z
      .object({
        legalName: z.string().trim().max(160).nullable(),
        address: z.string().trim().max(400).nullable(),
        taxId: z.string().trim().max(40).nullable(),
      })
      .optional(),
    minPaidPriceMinor: z.number().int().min(100).max(100_000_000).optional(),
    depositPlans: depositPlanRulesSchema.optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** GET /admin/settings (S-AD09): every group, the plan's upload caps and the last change. */
export const adminSettingsSchema = z.object({
  commerce: commerceSettingsSchema.extend({ minPaidPriceMinor: z.number().int() }),
  general: generalSettingsSchema,
  content: contentSettingsSchema.omit({ minPaidPriceMinor: true }),
  /** The plan's caps for upload sizes (min(platform, plan, school), 04 §17.8). */
  planCaps: z.object({ maxDocumentMb: z.number().int(), maxVideoGb: z.number() }),
  currency: z.string(),
  /** What the active payment account supports (null: no active account), for BR-62 in the form. */
  supported: z
    .object({
      methods: z.array(z.enum(['MOBILE_MONEY', 'CARD'])),
      refundApi: z.enum(['FULL', 'PARTIAL', 'NONE']),
    })
    .nullable(),
  revenueShare: z.boolean(),
  lastChange: z
    .object({
      key: z.string(),
      by: z.string().nullable(),
      at: z.iso.datetime(),
      reason: z.string().nullable(),
    })
    .nullable(),
});
export type AdminSettings = z.infer<typeof adminSettingsSchema>;
