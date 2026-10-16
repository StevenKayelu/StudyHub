import { z } from 'zod';

import {
  domainChangeRequestViewSchema,
  featureOverrideSchema,
  planFeaturesSchema,
  planLimitsSchema,
  planPricingSchema,
  statementSchema,
  supportGrantStatusSchema,
  supportScopeSchema,
  usageDaySchema,
} from './admin';
import { featureKeySchema } from './features';
import { emailSchema, newPasswordSchema, platformRoleSchema } from './identity';
import { tenantStatusSchema } from './tenant';

/**
 * Platform console API (05 §8.4, F43). Responses carry school METADATA and aggregates only: no names,
 * emails, answers or order details of school members (F43 AC 1, checked by the response-schema test in
 * console-exposure.test.ts). The single documented exception is `ownerContactEmail`, the business
 * contact staff typed in at provisioning (S-C04).
 */

const isoDate = z.iso.datetime();
const money = z.number().int();

export const tenantKindSchema = z.enum([
  'SCHOOL',
  'COLLEGE',
  'UNIVERSITY',
  'TUTORING_BUSINESS',
  'INDEPENDENT_TUTOR',
  'MARKETPLACE',
  'OTHER',
]);

export const consoleTenantRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  primaryHost: z.string().nullable(),
  status: tenantStatusSchema,
  kind: tenantKindSchema,
  planCode: z.string().nullable(),
  activeLearners: z.number().int().nullable(),
  storagePercent: z.number().nullable(),
  createdAt: isoDate,
});
export type ConsoleTenantRow = z.infer<typeof consoleTenantRowSchema>;

export const consoleTenantListSchema = z.object({ tenants: z.array(consoleTenantRowSchema) });

export const consoleTenantQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: tenantStatusSchema.optional(),
  plan: z.string().trim().max(40).optional(),
  kind: tenantKindSchema.optional(),
});

export const createTenantRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(160).optional(),
  kind: tenantKindSchema,
  slug: z.string().trim().toLowerCase().min(3).max(30),
  planCode: z.string().trim().min(2).max(40),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default('ZM'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('ZMW'),
  ownerEmail: emailSchema,
  receiptPrefix: z
    .string()
    .regex(/^[A-Z0-9]{2,8}$/)
    .optional(),
});
export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>;

export const createTenantResponseSchema = z.object({
  id: z.uuid(),
  status: tenantStatusSchema,
  primaryHost: z.string(),
  ownerInvitation: z.object({ email: z.string(), expiresAt: isoDate }),
});

export const consolePlanSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  features: planFeaturesSchema,
  limits: planLimitsSchema,
  pricing: planPricingSchema,
  isPublic: z.boolean(),
  status: z.enum(['ACTIVE', 'RETIRED']),
  tenantCount: z.number().int(),
  version: z.number().int(),
});
export type ConsolePlan = z.infer<typeof consolePlanSchema>;

export const consolePlanListSchema = z.object({ plans: z.array(consolePlanSchema) });

export const planInputSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,39}$/),
  name: z.string().trim().min(2).max(80),
  features: planFeaturesSchema,
  limits: planLimitsSchema,
  pricing: planPricingSchema,
  isPublic: z.boolean().default(true),
});
export const planPatchSchema = planInputSchema
  .omit({ code: true })
  .partial()
  .extend({ status: z.enum(['ACTIVE', 'RETIRED']).optional(), reason: z.string().trim().min(3).max(300) });

export const consoleSupportGrantSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  tenantName: z.string(),
  staffName: z.string(),
  staffId: z.uuid(),
  reason: z.string(),
  scope: supportScopeSchema,
  emergency: z.boolean(),
  status: supportGrantStatusSchema,
  durationMinutes: z.number().int(),
  requestedAt: isoDate,
  startsAt: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
});
export type ConsoleSupportGrant = z.infer<typeof consoleSupportGrantSchema>;

export const consoleSupportGrantListSchema = z.object({ grants: z.array(consoleSupportGrantSchema) });

export const consoleTenantDetailSchema = z.object({
  tenant: z.object({
    id: z.uuid(),
    name: z.string(),
    legalName: z.string().nullable(),
    slug: z.string(),
    kind: tenantKindSchema,
    status: tenantStatusSchema,
    country: z.string(),
    currency: z.string(),
    receiptPrefix: z.string().nullable(),
    /** Documented exception (S-C04): the contact staff entered at provisioning. */
    ownerContactEmail: z.string().nullable(),
    suspendedReason: z.string().nullable(),
    offboardingRequestedAt: isoDate.nullable(),
    deleteAfter: isoDate.nullable(),
    activatedAt: isoDate.nullable(),
    createdAt: isoDate,
  }),
  plan: z.object({ code: z.string(), name: z.string() }).nullable(),
  domains: z.array(
    z.object({
      hostname: z.string(),
      type: z.enum(['SUBDOMAIN', 'CUSTOM']),
      status: z.enum(['PENDING_VERIFICATION', 'ACTIVE', 'FAILED', 'REDIRECT']),
      isPrimary: z.boolean(),
      redirectUntil: isoDate.nullable(),
    }),
  ),
  features: z.array(
    z.object({
      key: featureKeySchema,
      planGrants: z.boolean(),
      override: featureOverrideSchema,
      enabledByTenant: z.boolean(),
      effective: z.boolean(),
    }),
  ),
  usage: z.array(usageDaySchema),
  supportGrants: z.array(consoleSupportGrantSchema),
  domainRequests: z.array(domainChangeRequestViewSchema),
  statements: z.array(statementSchema),
});
export type ConsoleTenantDetail = z.infer<typeof consoleTenantDetailSchema>;

export const lifecycleRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const tenantPatchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  legalName: z.string().trim().min(2).max(160).nullable().optional(),
  planCode: z.string().trim().min(2).max(40).optional(),
  receiptPrefix: z
    .string()
    .regex(/^[A-Z0-9]{2,8}$/)
    .nullable()
    .optional(),
  reason: z.string().trim().min(3).max(500),
});

export const featureOverrideRequestSchema = z.object({
  override: featureOverrideSchema,
  reason: z.string().trim().min(3).max(500),
});

export const ownerInvitationRequestSchema = z.object({ email: emailSchema.optional() });

// --- Staff (S-C07) ------------------------------------------------------------------------------------

export const createStaffRequestSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(120),
  role: platformRoleSchema,
  password: newPasswordSchema,
});
export const staffRoleRequestSchema = z.object({ role: platformRoleSchema });

// --- Global settings (S-C08) ---------------------------------------------------------------------------

export const consoleSettingsSchema = z.object({
  /** Shown on every school page and in the console until cleared. */
  maintenanceBanner: z.string().trim().max(300).nullable(),
  /** BR-47: the longest support grant (hours, 1–24). */
  supportMaxHours: z.number().int().min(1).max(24),
});
export type ConsoleSettings = z.infer<typeof consoleSettingsSchema>;
export const DEFAULT_CONSOLE_SETTINGS: ConsoleSettings = { maintenanceBanner: null, supportMaxHours: 24 };

export const consoleSettingsPatchSchema = consoleSettingsSchema
  .partial()
  .extend({ reason: z.string().trim().min(3).max(300) });

// --- Audit (S-C09) ------------------------------------------------------------------------------------

export const consoleAuditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  tenantId: z.uuid().nullable(),
  actorName: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  createdAt: isoDate,
});
export const consoleAuditPageSchema = z.object({
  entries: z.array(consoleAuditEntrySchema),
  nextBefore: z.string().nullable(),
});
export type ConsoleAuditPage = z.infer<typeof consoleAuditPageSchema>;

export const consoleAuditQuerySchema = z.object({
  tenantId: z.uuid().optional(),
  action: z.string().trim().max(80).optional(),
  actorId: z.uuid().optional(),
  before: z.coerce.number().int().positive().optional(),
});

// --- Overview, metrics and provider health (S-C02, S-C08) ----------------------------------------------

export const providerHealthSchema = z.object({
  providers: z.array(
    z.object({
      kind: z.enum(['payments', 'video', 'email', 'storage']),
      name: z.string(),
      status: z.enum(['OK', 'DEGRADED', 'DOWN', 'UNKNOWN']),
      detail: z.string().nullable(),
    }),
  ),
});
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

export const consoleOverviewSchema = z.object({
  tenantsByStatus: z.record(tenantStatusSchema, z.number().int()),
  newThisMonth: z.number().int(),
  nearLimits: z.array(
    z.object({
      tenantId: z.uuid(),
      name: z.string(),
      meter: z.enum(['activeLearners', 'storage']),
      percent: z.number(),
    }),
  ),
  pendingDomainRequests: z.number().int(),
  pendingSupportRequests: z.number().int(),
  providers: providerHealthSchema.shape.providers,
});
export type ConsoleOverview = z.infer<typeof consoleOverviewSchema>;

/** Aggregated, non-personal operations view (F43): counts and sums only. */
export const consoleMetricsSchema = z.object({
  tenants: z.number().int(),
  activeLearners: z.number().int(),
  instructors: z.number().int(),
  storageBytes: z.number(),
  paymentsLast30Days: z.object({ count: z.number().int(), amountMinor: money }),
  emailsLast30Days: z.number().int(),
});
export type ConsoleMetrics = z.infer<typeof consoleMetricsSchema>;

export const paymentProviderListSchema = z.object({
  providers: z.array(z.object({ name: z.string(), approved: z.boolean(), note: z.string() })),
});

// --- Domain change requests ------------------------------------------------------------------------------

export const consoleDomainRequestSchema = domainChangeRequestViewSchema.extend({
  tenantId: z.uuid(),
  tenantName: z.string(),
});
export const consoleDomainRequestListSchema = z.object({ requests: z.array(consoleDomainRequestSchema) });
export const domainDecisionRequestSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(500).optional(),
});

// --- Statements (W8) ---------------------------------------------------------------------------------

export const consoleStatementSchema = statementSchema.extend({ tenantId: z.uuid(), tenantName: z.string() });
export const consoleStatementListSchema = z.object({ statements: z.array(consoleStatementSchema) });
export const periodSchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
export const generateStatementsRequestSchema = z.object({ period: periodSchema });
export const generateStatementsResponseSchema = z.object({
  created: z.number().int(),
  skipped: z.number().int(),
});
export const markPaidRequestSchema = z.object({ externalReference: z.string().trim().min(1).max(120) });

// --- Support access (F44) ----------------------------------------------------------------------------

export const supportRequestSchema = z.object({
  tenantId: z.uuid(),
  reason: z.string().trim().min(20).max(1000),
  scope: supportScopeSchema.default('READ_ONLY'),
  durationMinutes: z.number().int().min(15).max(1440).default(240),
});
export const supportOpenResponseSchema = z.object({ url: z.url() });

export const consoleMoneySchema = money;
