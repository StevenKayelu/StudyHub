import { z } from 'zod';

import { featureKeySchema } from './features';
import { localeSchema, localizedTextSchema, SUPPORTED_LOCALES } from './i18n';
import { emailSchema, tenantRoleSchema } from './identity';
import {
  fontPresetSchema,
  footerLinkSchema,
  homeLayoutSchema,
  socialLinksSchema,
  terminologySchema,
} from './tenant';

/**
 * School administration (M9): plans and limits, branding editor, features, settings, users, queues,
 * reports and exports, notifications, audit log, support access, usage, onboarding, domains,
 * offboarding, settlement reconciliation (W7) and billing statements (W8). Blueprint 05 §4.9, §8.3.
 */

const isoDate = z.iso.datetime();
const day = z.iso.date();
const money = z.number().int();

// --- Plans and limits (F40, BR-48, BR-49) --------------------------------------------------------

export const planLimitsSchema = z.object({
  /** null: unlimited. */
  maxActiveLearners: z.number().int().min(0).nullable(),
  maxInstructors: z.number().int().min(0).nullable(),
  maxAdmins: z.number().int().min(0).nullable(),
  storageGb: z.number().min(0.1).max(100_000),
  videoMinutesPerMonth: z.number().int().min(0).nullable(),
  /** Video delivery is a soft limit unless the plan blocks it (BR-49). */
  hardBlockVideo: z.boolean(),
  maxDocumentMb: z.number().int().min(1).max(500),
  maxVideoGb: z.number().min(0.1).max(20),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

export const planPricingSchema = z.object({
  subscriptionFeeMinor: z.number().int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** BR-63: the share of a school's recorded sales owed to the platform (default 0). */
  platformCommissionBps: z.number().int().min(0).max(10_000),
});
export type PlanPricing = z.infer<typeof planPricingSchema>;

export const planFeaturesSchema = z.partialRecord(featureKeySchema, z.boolean());
export type PlanFeatures = z.infer<typeof planFeaturesSchema>;

/** A school without a plan gets these (M9 PROPOSED 7); also the `starter` seed plan. */
export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  maxActiveLearners: 200,
  maxInstructors: 5,
  maxAdmins: 2,
  storageGb: 10,
  videoMinutesPerMonth: 5000,
  hardBlockVideo: false,
  maxDocumentMb: 50,
  maxVideoGb: 4,
};

export const planSummarySchema = z.object({
  code: z.string(),
  name: z.string(),
  limits: planLimitsSchema,
  features: planFeaturesSchema,
});
export type PlanSummary = z.infer<typeof planSummarySchema>;

// --- Branding editor (F39, S-AD12) ---------------------------------------------------------------

export const brandingDraftSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  accentHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .transform((value) => value.toLowerCase())
    .nullable(),
  fontPreset: fontPresetSchema,
  logoAssetId: z.uuid().nullable(),
  logoDarkAssetId: z.uuid().nullable(),
  faviconAssetId: z.uuid().nullable(),
  appIconAssetId: z.uuid().nullable(),
  homeLayout: homeLayoutSchema,
  footerLinks: z.array(footerLinkSchema).max(8),
  supportEmail: emailSchema.nullable(),
  supportPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/, 'Enter a phone number')
    .nullable(),
  social: socialLinksSchema,
  terminology: terminologySchema,
  emailFromName: localizedTextSchema.nullable(),
  showPoweredBy: z.boolean(),
});
export type BrandingDraft = z.infer<typeof brandingDraftSchema>;

export const brandingEditorSchema = z.object({
  draft: brandingDraftSchema,
  /** True when the draft differs from what is published. */
  hasUnpublishedChanges: z.boolean(),
  publishedVersion: z.number().int(),
  publishedAt: isoDate.nullable(),
  versions: z.array(
    z.object({ version: z.number().int(), publishedAt: isoDate, publishedBy: z.string().nullable() }),
  ),
  /** `showPoweredBy: false` needs the whiteLabel feature. */
  whiteLabelAllowed: z.boolean(),
  /** Download URLs for the uploaded images in the draft (short-lived). */
  assetUrls: z.record(z.string(), z.string()),
});
export type BrandingEditor = z.infer<typeof brandingEditorSchema>;

export const validateColourRequestSchema = z.object({ accentHex: z.string().regex(/^#[0-9a-fA-F]{6}$/) });

export const contrastCheckSchema = z.object({
  pair: z.string(),
  ratio: z.number(),
  required: z.number(),
  pass: z.boolean(),
});

export const validateColourResponseSchema = z.object({
  ok: z.boolean(),
  /** The colour actually used after automatic adjustment (light theme accent). */
  adjusted: z.string().nullable(),
  checks: z.object({ light: z.array(contrastCheckSchema), dark: z.array(contrastCheckSchema) }),
  suggestions: z.array(z.string()),
  message: z.string().nullable(),
});
export type ValidateColourResponse = z.infer<typeof validateColourResponseSchema>;

// --- Features (F40, S-AD13) -----------------------------------------------------------------------

export const featureOverrideSchema = z.enum(['NONE', 'GRANT', 'REVOKE']);
export type FeatureOverrideValue = z.infer<typeof featureOverrideSchema>;

export const adminFeaturesSchema = z.object({
  features: z.array(
    z.object({
      key: featureKeySchema,
      /** Granted by the plan or a platform override, and not revoked. */
      available: z.boolean(),
      planGrants: z.boolean(),
      override: featureOverrideSchema,
      enabledByTenant: z.boolean(),
      effective: z.boolean(),
      /** Not built yet (custom domains, certificates). */
      later: z.boolean(),
    }),
  ),
});
export type AdminFeatures = z.infer<typeof adminFeaturesSchema>;

export const setFeatureRequestSchema = z.object({ enabled: z.boolean() });

// --- Settings (F41, S-AD09) -----------------------------------------------------------------------

/** Long per-locale text (legal pages). */
export const localizedLongTextSchema = z.record(localeSchema, z.string().trim().min(1).max(50_000));

export const LEGAL_PAGES = ['terms', 'privacy', 'refunds'] as const;
export const legalPageSchema = z.enum(LEGAL_PAGES);
export type LegalPage = z.infer<typeof legalPageSchema>;

export const legalPagesSchema = z.partialRecord(legalPageSchema, localizedLongTextSchema);

/** Settings groups that are not commerce (05 §8.2 tenant_setting, BR-02, BR-56, BR-57, BR-64). */
export const generalSettingsSchema = z.object({
  learnerRegistrationMode: z.enum(['OPEN', 'INVITE_ONLY', 'EMAIL_DOMAIN']).default('OPEN'),
  allowedEmailDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
    )
    .max(50)
    .default([]),
  unverifiedFreeEnrolment: z.boolean().default(true),
  legalPages: legalPagesSchema.default({}),
});
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

export const GENERAL_SETTING_KEYS = Object.keys(generalSettingsSchema.shape) as (keyof GeneralSettings)[];

export function generalSettingsFrom(rows: { key: string; value: unknown }[]): GeneralSettings {
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    const field = (generalSettingsSchema.shape as Record<string, z.ZodType>)[row.key];
    if (field !== undefined && field.safeParse(row.value).success) values[row.key] = row.value;
  }
  return generalSettingsSchema.parse(values);
}

// --- Locales (BR-61) ------------------------------------------------------------------------------

export const adminLocalesSchema = z.object({
  available: z.array(z.string()),
  defaultLocale: localeSchema,
  enabledLocales: z.array(localeSchema),
  timeZone: z.string(),
});
export type AdminLocales = z.infer<typeof adminLocalesSchema>;

export const putLocalesRequestSchema = z
  .object({
    defaultLocale: z.enum(SUPPORTED_LOCALES),
    enabledLocales: z.array(z.enum(SUPPORTED_LOCALES)).min(1).max(SUPPORTED_LOCALES.length),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown time zone'),
    reason: z.string().trim().min(3).max(300),
  })
  .refine((value) => value.enabledLocales.includes(value.defaultLocale), {
    message: 'The default language must be enabled',
    path: ['enabledLocales'],
  });

// --- Users (F30, S-AD03) ----------------------------------------------------------------------------

export const membershipStatusSchema = z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED']);

export const adminUserRowSchema = z.object({
  membershipId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  roles: z.array(tenantRoleSchema),
  status: membershipStatusSchema,
  emailVerified: z.boolean(),
  joinedAt: isoDate.nullable(),
  lastActiveAt: isoDate.nullable(),
});
export type AdminUserRow = z.infer<typeof adminUserRowSchema>;

export const adminUsersSchema = z.object({ users: z.array(adminUserRowSchema), total: z.number().int() });
export type AdminUsers = z.infer<typeof adminUsersSchema>;

export const auditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actorName: z.string().nullable(),
  actorKind: z.enum(['MEMBER', 'STAFF', 'SYSTEM']),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  createdAt: isoDate,
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const adminUserDetailSchema = z.object({
  user: adminUserRowSchema.extend({ isSelf: z.boolean() }),
  enrollments: z.array(
    z.object({
      id: z.uuid(),
      courseId: z.uuid(),
      courseTitle: z.string(),
      status: z.string(),
      source: z.string(),
      enrolledAt: isoDate,
    }),
  ),
  orders: z.array(
    z.object({
      id: z.uuid(),
      courseTitle: z.string(),
      amountMinor: money,
      currency: z.string(),
      status: z.string(),
      createdAt: isoDate,
    }),
  ),
  sessions: z.array(
    z.object({
      id: z.uuid(),
      createdAt: isoDate,
      lastSeenAt: isoDate,
      userAgent: z.string().nullable(),
      ip: z.string().nullable(),
    }),
  ),
  audit: z.array(auditEntrySchema),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

export const reasonRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });

// --- Queues (F31) -------------------------------------------------------------------------------------

export const QUEUE_KEYS = [
  'applications',
  'reviews',
  'paymentExceptions',
  'settlement',
  'supportAccess',
] as const;
export const queueSummarySchema = z.object({
  queues: z.array(
    z.object({
      key: z.enum(QUEUE_KEYS),
      count: z.number().int(),
      oldestAt: isoDate.nullable(),
      /** The oldest item is older than 72 hours (F31 AC). */
      overdue: z.boolean(),
    }),
  ),
});
export type QueueSummary = z.infer<typeof queueSummarySchema>;

// --- Reports and exports (F32) -----------------------------------------------------------------------

export const reportIntervalSchema = z.enum(['day', 'week', 'month']);

export const reportQuerySchema = z
  .object({ from: day, to: day, interval: reportIntervalSchema.default('day') })
  .refine((value) => value.from <= value.to, { message: 'The start must be before the end', path: ['to'] })
  .refine((value) => Date.parse(value.to) - Date.parse(value.from) <= 366 * 86_400_000, {
    message: 'Pick a range of a year or less',
    path: ['to'],
  });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const reportOverviewSchema = z.object({
  from: day,
  to: day,
  interval: reportIntervalSchema,
  currency: z.string(),
  revenue: z.object({ gross: money, refunds: money, net: money, orders: z.number().int() }),
  newLearners: z.number().int(),
  enrolments: z.number().int(),
  series: z.array(
    z.object({
      period: day,
      gross: money,
      refunds: money,
      net: money,
      enrolments: z.number().int(),
      newLearners: z.number().int(),
    }),
  ),
  topCourses: z.array(
    z.object({ courseId: z.uuid(), title: z.string(), enrolments: z.number().int(), revenueMinor: money }),
  ),
  paymentSuccess: z.array(
    z.object({
      method: z.enum(['MOBILE_MONEY', 'CARD']),
      attempted: z.number().int(),
      succeeded: z.number().int(),
      rate: z.number().nullable(),
    }),
  ),
});
export type ReportOverview = z.infer<typeof reportOverviewSchema>;

export const REPORT_EXPORT_TYPES = ['ORDERS', 'PAYMENTS', 'LEDGER', 'ENROLMENTS'] as const;
export const exportTypeSchema = z.enum([...REPORT_EXPORT_TYPES, 'TENANT_FULL']);
export type ExportTypeName = z.infer<typeof exportTypeSchema>;

export const createExportRequestSchema = z
  .object({ type: z.enum(REPORT_EXPORT_TYPES), from: day, to: day })
  .refine((value) => value.from <= value.to, { message: 'The start must be before the end', path: ['to'] });

export const exportSchema = z.object({
  id: z.uuid(),
  type: exportTypeSchema,
  status: z.enum(['QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED']),
  params: z.object({ from: day.optional(), to: day.optional() }),
  rowCount: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  createdAt: isoDate,
  completedAt: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  /** Short-lived download link while READY. */
  downloadUrl: z.string().nullable(),
});
export type ExportView = z.infer<typeof exportSchema>;

export const exportListSchema = z.object({ exports: z.array(exportSchema) });

// --- Notifications (F33) ---------------------------------------------------------------------------

export const notificationSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  readAt: isoDate.nullable(),
  createdAt: isoDate,
});
export const notificationListSchema = z.object({
  unread: z.number().int(),
  items: z.array(notificationSchema),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

export const markReadRequestSchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
  z.object({ all: z.literal(true) }),
]);

export const NOTIFICATION_CATEGORIES = ['learning', 'earnings'] as const;
export const notificationPreferencesSchema = z.object({ learning: z.boolean(), earnings: z.boolean() });
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

// --- Audit log (F34, F49) -------------------------------------------------------------------------------

export const auditQuerySchema = z.object({
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(60).optional(),
  actorId: z.uuid().optional(),
  from: day.optional(),
  to: day.optional(),
  before: z.coerce.number().int().positive().optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditPageSchema = z.object({
  entries: z.array(auditEntrySchema),
  nextBefore: z.string().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

// --- Support access (F44, S-AD16) -----------------------------------------------------------------------

export const supportScopeSchema = z.enum(['READ_ONLY', 'READ_WRITE']);
export const supportGrantStatusSchema = z.enum([
  'REQUESTED',
  'APPROVED',
  'DENIED',
  'ACTIVE',
  'EXPIRED',
  'REVOKED',
]);

export const supportGrantSchema = z.object({
  id: z.uuid(),
  staffName: z.string(),
  reason: z.string(),
  scope: supportScopeSchema,
  emergency: z.boolean(),
  status: supportGrantStatusSchema,
  durationMinutes: z.number().int(),
  requestedAt: isoDate,
  decidedAt: isoDate.nullable(),
  startsAt: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
});
export type SupportGrant = z.infer<typeof supportGrantSchema>;

export const supportGrantListSchema = z.object({ grants: z.array(supportGrantSchema) });

export const supportDecisionRequestSchema = z.object({ decision: z.enum(['APPROVE', 'DENY']) });

export const supportSessionInfoSchema = z.object({
  active: z.boolean(),
  staffName: z.string().nullable(),
  scope: supportScopeSchema.nullable(),
  expiresAt: isoDate.nullable(),
});
export type SupportSessionInfo = z.infer<typeof supportSessionInfoSchema>;

// --- Usage and plan (F47, S-AD17) -----------------------------------------------------------------------

export const usageMeterSchema = z.object({
  key: z.enum(['activeLearners', 'instructors', 'admins', 'storage', 'videoMinutes']),
  used: z.number(),
  limit: z.number().nullable(),
  percent: z.number().nullable(),
  state: z.enum(['OK', 'WARN', 'FULL']),
});
export type UsageMeter = z.infer<typeof usageMeterSchema>;

export const usageDaySchema = z.object({
  date: day,
  activeLearners: z.number().int(),
  instructors: z.number().int(),
  admins: z.number().int(),
  storageBytes: z.number(),
  videoMinutesDelivered: z.number().int(),
  emailsSent: z.number().int(),
  paymentsCount: z.number().int(),
  paymentsAmountMinor: money,
});
export type UsageDay = z.infer<typeof usageDaySchema>;

export const adminUsageSchema = z.object({
  plan: planSummarySchema,
  meters: z.array(usageMeterSchema),
  daily: z.array(usageDaySchema),
});
export type AdminUsage = z.infer<typeof adminUsageSchema>;

// --- Onboarding checklist (S-AD11) ---------------------------------------------------------------------

export const ONBOARDING_STEPS = ['branding', 'policies', 'payments', 'instructors', 'course'] as const;
export const onboardingSchema = z.object({
  status: z.enum(['PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'DELETED']),
  steps: z.array(z.object({ key: z.enum(ONBOARDING_STEPS), done: z.boolean(), required: z.boolean() })),
  canGoLive: z.boolean(),
});
export type Onboarding = z.infer<typeof onboardingSchema>;

// --- Domains (S-AD19, BR-50) ---------------------------------------------------------------------------

export const slugProblemSchema = z.enum(['FORMAT', 'RESERVED', 'DOUBLE_HYPHEN', 'TAKEN']);

export const slugAvailabilitySchema = z.object({
  slug: z.string(),
  available: z.boolean(),
  problem: slugProblemSchema.nullable(),
});

export const domainChangeRequestViewSchema = z.object({
  id: z.uuid(),
  currentSlug: z.string(),
  requestedSlug: z.string(),
  reason: z.string(),
  status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED']),
  decisionNote: z.string().nullable(),
  createdAt: isoDate,
  decidedAt: isoDate.nullable(),
});
export type DomainChangeRequestView = z.infer<typeof domainChangeRequestViewSchema>;

export const domainViewSchema = z.object({
  hostname: z.string(),
  type: z.enum(['SUBDOMAIN', 'CUSTOM']),
  status: z.enum(['PENDING_VERIFICATION', 'ACTIVE', 'FAILED', 'REDIRECT']),
  isPrimary: z.boolean(),
  redirectUntil: isoDate.nullable(),
});

export const adminDomainsSchema = z.object({
  slug: z.string(),
  domains: z.array(domainViewSchema),
  requests: z.array(domainChangeRequestViewSchema),
  customDomainsEnabled: z.boolean(),
});
export type AdminDomains = z.infer<typeof adminDomainsSchema>;

export const domainChangeRequestSchema = z.object({
  requestedSlug: z.string().trim().toLowerCase().min(3).max(30),
  reason: z.string().trim().min(3).max(500),
});

// --- Offboarding (F46, S-AD18) ---------------------------------------------------------------------------

export const offboardingSchema = z.object({
  status: z.enum(['PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'DELETED']),
  requestedAt: isoDate.nullable(),
  deleteAfter: isoDate.nullable(),
  graceDays: z.number().int(),
});
export type OffboardingView = z.infer<typeof offboardingSchema>;

export const offboardingRequestSchema = z.object({ confirmName: z.string().trim().min(1).max(120) });

// --- Settlement reconciliation (W7, S-AD20) -----------------------------------------------------------

export const settlementKindSchema = z.enum(['MISSING_LOCAL', 'MISSING_PROVIDER', 'AMOUNT_MISMATCH']);
export const settlementResolutionSchema = z.enum(['RECHECKED', 'ACCEPTED', 'REFUND_STARTED', 'NOTED']);

export const settlementReportSummarySchema = z.object({
  id: z.uuid(),
  periodStart: day,
  periodEnd: day,
  source: z.enum(['API', 'CSV']),
  status: z.enum(['PROCESSING', 'READY', 'FAILED']),
  providerCount: z.number().int(),
  localCount: z.number().int(),
  matchedCount: z.number().int(),
  mismatchCount: z.number().int(),
  unresolvedCount: z.number().int(),
  error: z.string().nullable(),
  createdAt: isoDate,
});
export type SettlementReportSummary = z.infer<typeof settlementReportSummarySchema>;

export const settlementListSchema = z.object({
  reports: z.array(settlementReportSummarySchema),
  /** The active account can list transactions (otherwise CSV upload only). */
  canFetch: z.boolean(),
  hasAccount: z.boolean(),
});
export type SettlementList = z.infer<typeof settlementListSchema>;

export const settlementItemSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  kind: settlementKindSchema,
  paymentId: z.uuid().nullable(),
  orderId: z.uuid().nullable(),
  localAmountMinor: money.nullable(),
  providerAmountMinor: money.nullable(),
  currency: z.string(),
  resolution: settlementResolutionSchema.nullable(),
  note: z.string().nullable(),
  resolvedAt: isoDate.nullable(),
});
export type SettlementItemView = z.infer<typeof settlementItemSchema>;

export const settlementDetailSchema = z.object({
  report: settlementReportSummarySchema,
  items: z.array(settlementItemSchema),
});
export type SettlementDetail = z.infer<typeof settlementDetailSchema>;

export const createSettlementRequestSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('API'), from: day, to: day }),
  z.object({ source: z.literal('CSV'), from: day, to: day, csv: z.string().min(1).max(1_000_000) }),
]);

export const resolveSettlementItemSchema = z.object({
  action: z.enum(['RECHECK', 'ACCEPT', 'REFUND', 'NOTE']),
  note: z.string().trim().max(500).optional(),
});

/** The CSV statement template's header (W7). */
export const SETTLEMENT_CSV_HEADER = 'reference,amount_minor,currency,status,date';

// --- Billing statements (W8, S-AD21) -----------------------------------------------------------------

export const statementStatusSchema = z.enum(['DRAFT', 'ISSUED', 'PAID', 'VOID']);

export const statementSchema = z.object({
  id: z.uuid(),
  period: z.string(),
  planCode: z.string().nullable(),
  subscriptionFeeMinor: money,
  salesGrossMinor: money,
  refundsMinor: money,
  platformCommissionBps: z.number().int(),
  platformCommissionMinor: money,
  totalDueMinor: money,
  currency: z.string(),
  status: statementStatusSchema,
  issuedAt: isoDate.nullable(),
  paidAt: isoDate.nullable(),
  externalReference: z.string().nullable(),
});
export type Statement = z.infer<typeof statementSchema>;

export const statementListSchema = z.object({ statements: z.array(statementSchema) });

// --- Public legal pages (F36 per school) -------------------------------------------------------------

export const legalPageResponseSchema = z.object({ page: legalPageSchema, body: z.string().nullable() });
