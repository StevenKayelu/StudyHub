import { z } from 'zod';

/**
 * SaaS billing (docs/design/saas-billing.md): what a school owes the platform. Commercial plans are
 * versioned; a published version is immutable. Amounts are integer minor units of the version's
 * currency; percentages are basis points (1 % = 100 bps). No prices are built in: platform staff set them.
 */

const key = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, 'Lower-case letters, digits and hyphens, starting with a letter');
const label = z.string().trim().min(2).max(120);
/** Up to 1 000 000 000.00 in major units. */
const minor = z.number().int().min(0).max(100_000_000_000);
const bps = z.number().int().min(0).max(10_000);

export const billingCycleSchema = z.enum(['MONTH', 'QUARTER', 'YEAR']);
export type BillingCycle = z.infer<typeof billingCycleSchema>;

/** How students become billable for per-student pricing; the rule is recorded on each snapshot. */
export const billableStudentRuleSchema = z.enum([
  /** Members with the learner role who are active at the end of the period. */
  'ACTIVE_LEARNERS',
  /** Distinct learners with an enrolment that was active at any time in the period. */
  'ENROLLED_LEARNERS',
]);
export type BillableStudentRule = z.infer<typeof billableStudentRuleSchema>;

/** Which education payments count for revenue share: the order item part (M8 deposit plans). */
export const eligiblePartSchema = z.enum(['FULL', 'DEPOSIT', 'BALANCE']);

export const paymentModeSchema = z.enum([
  /** Mode B: the school's own merchant account. */
  'TENANT_MERCHANT',
  /** Mode A: the platform's merchant collects; the school's share is settled to it. */
  'PLATFORM_MERCHANT',
  /** Mode C: the platform collects and settles on a schedule, with approvals. */
  'PLATFORM_COLLECT_SETTLE',
]);
export type PaymentMode = z.infer<typeof paymentModeSchema>;

export const fixedComponentSchema = z.object({
  type: z.literal('FIXED'),
  key,
  label,
  category: z.enum([
    'LICENCE',
    'HOSTING',
    'MAINTENANCE',
    'SERVICE',
    'DOMAIN',
    'STORAGE',
    'MESSAGING',
    'VIDEO',
    'PREMIUM',
  ]),
  /** Per billing cycle; prorated for partial periods. */
  amountMinor: minor,
  /** An add-on: billed only when the school's contract enables it. */
  optional: z.boolean().default(false),
});

export const perStudentComponentSchema = z
  .object({
    type: z.literal('PER_STUDENT'),
    key,
    label,
    billableRule: billableStudentRuleSchema,
    unitAmountMinor: minor,
    /** Students included at no charge. */
    includedStudents: z.number().int().min(0).max(10_000_000).default(0),
    /** Students above this count are charged the overage rate (null: no overage tier). */
    overageThreshold: z.number().int().min(1).max(10_000_000).nullable().default(null),
    overageUnitAmountMinor: minor.nullable().default(null),
    /** The least this component charges per full cycle (prorated for partial periods). */
    minimumMinor: minor.default(0),
  })
  .refine((c) => (c.overageThreshold === null) === (c.overageUnitAmountMinor === null), {
    message: 'Set both the overage threshold and the overage rate, or neither',
    path: ['overageUnitAmountMinor'],
  });

export const revenueShareComponentSchema = z.object({
  type: z.literal('REVENUE_SHARE'),
  key,
  label,
  bps,
  fixedFeePerTransactionMinor: minor.default(0),
  /** The least this component charges per full cycle (prorated for partial periods). */
  minimumMinor: minor.default(0),
  eligibleParts: z.array(eligiblePartSchema).min(1).max(3),
  refundsReduceBase: z.boolean().default(true),
  providerFeesReduceBase: z.boolean().default(false),
});

/**
 * One-time charges, billed on the first invoice of a contract. A licence states its terms explicitly:
 * it never implies source code, hosting or maintenance unless they are listed here.
 */
export const oneTimeComponentSchema = z.object({
  type: z.literal('ONE_TIME'),
  key,
  label,
  category: z.enum(['SETUP', 'BRANDING', 'CUSTOM_DEVELOPMENT', 'LICENCE', 'SERVICE']),
  amountMinor: minor,
  licence: z
    .object({
      kind: z.enum(['TERM', 'PERPETUAL_USE']),
      sourceCodeIncluded: z.boolean().default(false),
      hostingIncludedMonths: z.number().int().min(0).max(120).default(0),
      maintenanceIncludedMonths: z.number().int().min(0).max(120).default(0),
    })
    .nullable()
    .default(null),
});

export const planComponentSchema = z.union([
  fixedComponentSchema,
  perStudentComponentSchema,
  revenueShareComponentSchema,
  oneTimeComponentSchema,
]);
export type PlanComponent = z.infer<typeof planComponentSchema>;

const uniqueKeys = (components: { key: string }[]) =>
  new Set(components.map((c) => c.key)).size === components.length;

export const planVersionInputSchema = z.object({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
  billingCycle: billingCycleSchema,
  trialDays: z.number().int().min(0).max(365).default(0),
  graceDays: z.number().int().min(0).max(90).default(7),
  paymentTermsDays: z.number().int().min(0).max(90).default(14),
  components: z
    .array(planComponentSchema)
    .min(1)
    .max(30)
    .refine(uniqueKeys, 'Each component needs its own key'),
  allowedPaymentModes: z.array(paymentModeSchema).min(1).max(3),
  notes: z.string().trim().max(2000).default(''),
});
export type PlanVersionInput = z.infer<typeof planVersionInputSchema>;

export const commercialPlanInputSchema = z.object({
  code: key,
  name: label,
  description: z.string().trim().max(2000).default(''),
  /** Tenant kinds that may use the plan (empty: every kind). */
  audience: z
    .array(
      z.enum([
        'SCHOOL',
        'COLLEGE',
        'UNIVERSITY',
        'TUTORING_BUSINESS',
        'INDEPENDENT_TUTOR',
        'MARKETPLACE',
        'OTHER',
      ]),
    )
    .max(7)
    .default([]),
  /** CONTRACT_ONLY plans are never offered to schools; staff assign them in contracts. */
  visibility: z.enum(['PUBLIC', 'CONTRACT_ONLY']).default('PUBLIC'),
  /** The feature and limit plan (`plan`) a subscription to this plan grants. */
  featurePlanCode: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,39}$/)
    .nullable()
    .default(null),
});

export const discountSchema = z
  .object({
    key,
    label,
    kind: z.enum(['PERCENT', 'AMOUNT']),
    /** PERCENT: basis points; AMOUNT: minor units per invoice. */
    value: z.number().int().min(1).max(100_000_000_000),
    /** Component keys it applies to (empty: every recurring component). */
    appliesTo: z.array(key).max(30).default([]),
    /** How many invoices it applies to, counting from the first (null: all). */
    invoices: z.number().int().min(1).max(120).nullable().default(null),
    /** A promotional code it came from, for the record. */
    couponCode: z.string().trim().max(40).nullable().default(null),
  })
  .refine((d) => d.kind !== 'PERCENT' || d.value <= 10_000, {
    message: 'A percentage can be at most 100 %',
    path: ['value'],
  });
export type Discount = z.infer<typeof discountSchema>;

const isoDate = z.iso.date();

export const contractInputSchema = z
  .object({
    planVersionId: z.uuid(),
    kind: z.enum(['STANDARD', 'ENTERPRISE']).default('STANDARD'),
    /** Negotiated components: replace a plan component with the same key, or add one (ENTERPRISE). */
    overrides: z.array(planComponentSchema).max(30).default([]),
    enabledAddons: z.array(key).max(30).default([]),
    discounts: z.array(discountSchema).max(10).default([]),
    /** Day of the month billing periods start on (1–28). */
    billingAnchorDay: z.number().int().min(1).max(28).default(1),
    startsOn: isoDate,
    endsOn: isoDate.nullable().default(null),
    note: z.string().trim().max(2000).default(''),
  })
  .refine((c) => c.endsOn === null || c.endsOn > c.startsOn, {
    message: 'End after the start',
    path: ['endsOn'],
  })
  .refine((c) => uniqueKeys(c.overrides), {
    message: 'Each override needs its own key',
    path: ['overrides'],
  });
export type ContractInput = z.infer<typeof contractInputSchema>;

/** What a plan preview prices against (no school data involved). */
export const pricingPreviewInputSchema = z.object({
  periodStart: isoDate,
  /** Learners for each billable rule. */
  students: z.object({
    ACTIVE_LEARNERS: z.number().int().min(0).max(10_000_000).default(0),
    ENROLLED_LEARNERS: z.number().int().min(0).max(10_000_000).default(0),
  }),
  /** Education collections in the period by part, for revenue share. */
  revenue: z
    .object({
      grossMinor: minor.default(0),
      refundsMinor: minor.default(0),
      providerFeesMinor: minor.default(0),
      transactions: z.number().int().min(0).max(10_000_000).default(0),
    })
    .default({ grossMinor: 0, refundsMinor: 0, providerFeesMinor: 0, transactions: 0 }),
  firstInvoice: z.boolean().default(true),
});

export const invoiceLineKindSchema = z.enum([
  'LICENCE',
  'HOSTING',
  'MAINTENANCE',
  'SERVICE',
  'PER_STUDENT',
  'OVERAGE',
  'REVENUE_SHARE',
  'TRANSACTION_FEE',
  'MINIMUM_TOPUP',
  'ONE_TIME',
  'DISCOUNT',
]);

export const invoiceLineViewSchema = z.object({
  kind: invoiceLineKindSchema,
  componentKey: z.string(),
  description: z.string(),
  quantity: z.string(),
  unitAmountMinor: z.string(),
  amountMinor: z.string(),
  revenueAccount: z.string(),
  calculation: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

/** Amounts are strings of integer minor units (they can exceed 2^53 in totals). */
export const invoiceViewSchema = z.object({
  id: z.uuid().nullable(),
  number: z.string().nullable(),
  tenantId: z.uuid().nullable(),
  status: z.enum(['PREVIEW', 'DRAFT', 'ISSUED', 'PAID', 'VOID']),
  currency: z.string(),
  periodStart: isoDate,
  periodEnd: isoDate,
  subtotalMinor: z.string(),
  discountMinor: z.string(),
  taxMinor: z.string(),
  totalMinor: z.string(),
  issuedAt: z.iso.datetime().nullable(),
  dueAt: z.iso.datetime().nullable(),
  lines: z.array(invoiceLineViewSchema),
});
export type InvoiceView = z.infer<typeof invoiceViewSchema>;

export const invoiceDraftInputSchema = z.object({
  /** Any date in the billing period to invoice; the period follows the contract's cycle and anchor. */
  forDate: isoDate,
});
export const invoiceVoidSchema = z.object({ reason: z.string().trim().min(5).max(500) });
