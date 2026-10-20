import { z } from 'zod';

/**
 * Commerce contracts (M8; blueprint 05 §3.6, §3.7, §4.8, §4.9, §5, §8.2 payment_account; F24–F29, F45).
 * Money is an integer in minor units (ngwee) with an ISO currency code (BR-06).
 */

export const paymentMethodSchema = z.enum(['MOBILE_MONEY', 'CARD']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const mobileNetworkSchema = z.enum(['MTN', 'AIRTEL', 'ZAMTEL']);
export type MobileNetwork = z.infer<typeof mobileNetworkSchema>;

/**
 * Zambian mobile prefixes per network (Q-PAY-2, still to be verified with the provider): the two digits
 * after the leading 0 (or after +260).
 */
export const NETWORK_PREFIXES: Readonly<Record<MobileNetwork, readonly string[]>> = {
  MTN: ['96', '76'],
  AIRTEL: ['97', '77'],
  ZAMTEL: ['95', '75'],
};

/** "+260 97 123 4567", "0971234567" or "260971234567" → "+260971234567"; null when not a Zambian mobile. */
export function normalizeMsisdn(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '');
  const match = /^(?:\+?260|0)([79][5-7]\d{7})$/.exec(digits);
  return match === null ? null : `+260${match[1]}`;
}

/** The network a normalised number belongs to, from its prefix. */
export function detectNetwork(msisdn: string): MobileNetwork | null {
  const normalized = normalizeMsisdn(msisdn);
  if (normalized === null) return null;
  const prefix = normalized.slice(4, 6);
  for (const network of mobileNetworkSchema.options) {
    if (NETWORK_PREFIXES[network].includes(prefix)) return network;
  }
  return null;
}

/** "+260 97 ••• 567" (PII is shown masked everywhere after entry). */
export function maskMsisdn(msisdn: string): string {
  const normalized = normalizeMsisdn(msisdn) ?? msisdn;
  return `${normalized.slice(0, 4)} ${normalized.slice(4, 6)} ••• ${normalized.slice(-3)}`;
}

// ---------------------------------------------------------------------------------------------
// Payment accounts and the capability model (F45, 04 §17.10, BR-62)
// ---------------------------------------------------------------------------------------------

export const refundApiSchema = z.enum(['FULL', 'PARTIAL', 'NONE']);

/** What a connected account can do, as its connection test detected it. */
export const paymentCapabilitiesSchema = z.object({
  mobileMoney: z.object({ networks: z.array(mobileNetworkSchema) }).nullable(),
  card: z.boolean(),
  refundApi: refundApiSchema,
  statusQuery: z.boolean(),
  transactionListApi: z.boolean(),
  disbursementApi: z.boolean(),
  currencies: z.array(z.string().length(3)),
  webhookSigning: z.string(),
});
export type PaymentCapabilities = z.infer<typeof paymentCapabilitiesSchema>;

/** The payment methods an account supports. */
export function supportedMethods(capabilities: PaymentCapabilities | null): PaymentMethod[] {
  if (capabilities === null) return [];
  return [
    ...(capabilities.mobileMoney !== null && capabilities.mobileMoney.networks.length > 0
      ? (['MOBILE_MONEY'] as const)
      : []),
    ...(capabilities.card ? (['CARD'] as const) : []),
  ];
}

export const paymentAccountStatusSchema = z.enum(['PENDING', 'ACTIVE', 'DISABLED', 'FAILED_TEST']);

/** Capability combinations the fake adapter can simulate (development and tests only). */
export const FAKE_PROFILES = ['FULL', 'MOBILE_ONLY', 'CARD_ONLY', 'NO_REFUND_API', 'PARTIAL_REFUND'] as const;

/** Credentials of the fake provider. Real providers get their own schema when approved (Q-PAY-3). */
export const fakeCredentialsSchema = z.object({
  merchantId: z.string().trim().min(4).max(64),
  apiKey: z.string().trim().min(8).max(200),
  webhookSecret: z.string().min(16).max(200),
  profile: z.enum(FAKE_PROFILES).default('FULL'),
});
export type FakeCredentials = z.infer<typeof fakeCredentialsSchema>;

/** Providers that may be connected. Only the fake exists until one is approved (Q-PAY-3). */
export const paymentProviderSchema = z.enum(['fake']);

export const createPaymentAccountSchema = z.object({
  provider: paymentProviderSchema,
  label: z.string().trim().min(1).max(80),
  credentials: z.record(z.string(), z.unknown()),
});

export const replaceCredentialsSchema = z.object({
  credentials: z.record(z.string(), z.unknown()),
});

/** A payment account as the API returns it: credentials are write-only (F45 AC 3). */
export const paymentAccountViewSchema = z.object({
  id: z.uuid(),
  provider: z.string(),
  label: z.string(),
  status: paymentAccountStatusSchema,
  maskedHint: z.string(),
  capabilities: paymentCapabilitiesSchema.nullable(),
  lastTestedAt: z.iso.datetime().nullable(),
  lastTestResult: z.string().nullable(),
  webhookPath: z.string(),
  createdAt: z.iso.datetime(),
});
export type PaymentAccountView = z.infer<typeof paymentAccountViewSchema>;
export const paymentAccountListSchema = z.object({ accounts: z.array(paymentAccountViewSchema) });

// ---------------------------------------------------------------------------------------------
// Orders and payments (F25, F26; 05 §5)
// ---------------------------------------------------------------------------------------------

export const orderStatusSchema = z.enum(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED']);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const paymentStatusSchema = z.enum([
  'INITIATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'NEEDS_REVIEW',
  'REFUNDED',
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/** Normalised failure codes; the page maps each to plain words (S-L09). */
export const paymentFailureCodeSchema = z.enum([
  'INSUFFICIENT_FUNDS',
  'USER_DECLINED',
  'TIMEOUT',
  'PROVIDER_ERROR',
  'CARD_DECLINED',
  'NOT_FOUND',
]);
export type PaymentFailureCode = z.infer<typeof paymentFailureCodeSchema>;

export const moneySchema = z.object({ amountMinor: z.number().int(), currency: z.string().length(3) });
export type Money = z.infer<typeof moneySchema>;

/** Which part of the price an order charges (docs/design/payment-plans.md). */
export const orderPartSchema = z.enum(['FULL', 'DEPOSIT', 'BALANCE']);
export type OrderPart = z.infer<typeof orderPartSchema>;

export const createOrderSchema = z.object({ courseId: z.uuid(), part: orderPartSchema.default('FULL') });

export const startPaymentSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('MOBILE_MONEY'),
    msisdn: z.string().trim().min(9).max(20),
    network: mobileNetworkSchema.optional(),
  }),
  z.object({ method: z.literal('CARD') }),
]);
export type StartPayment = z.infer<typeof startPaymentSchema>;

export const nextActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('APPROVE_ON_PHONE'),
    network: mobileNetworkSchema,
    maskedMsisdn: z.string(),
    message: z.string(),
  }),
  z.object({ type: z.literal('REDIRECT'), url: z.string() }),
  z.object({ type: z.literal('NONE') }),
]);

export const paymentStartedSchema = z.object({
  paymentId: z.uuid(),
  status: paymentStatusSchema,
  nextAction: nextActionSchema,
  failureCode: paymentFailureCodeSchema.nullable(),
  pollAfterMs: z.number().int(),
});
export type PaymentStarted = z.infer<typeof paymentStartedSchema>;

export const orderViewSchema = z.object({
  id: z.uuid(),
  status: orderStatusSchema,
  expiresAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable(),
  total: moneySchema,
  items: z.array(
    z.object({
      courseId: z.uuid(),
      courseSlug: z.string(),
      title: z.string(),
      instructorName: z.string(),
      accessDays: z.number().int().nullable(),
      unitPrice: moneySchema,
      part: orderPartSchema,
    }),
  ),
  /** The latest payment of the order, if any (the page shows its state). */
  payment: z
    .object({
      id: z.uuid(),
      method: paymentMethodSchema,
      network: mobileNetworkSchema.nullable(),
      maskedMsisdn: z.string().nullable(),
      status: paymentStatusSchema,
      failureCode: paymentFailureCodeSchema.nullable(),
      createdAt: z.iso.datetime(),
      /** Development only: the fake provider's simulated phone (null with real providers). */
      simulatedPhone: z.boolean(),
    })
    .nullable(),
  receiptNumber: z.string().nullable(),
  /** The methods this school offers now: enabled in its settings AND supported by its account (BR-62). */
  methods: z.array(paymentMethodSchema),
  networks: z.array(mobileNetworkSchema),
  allowedActions: z.array(z.enum(['pay', 'cancel'])),
});
export type OrderView = z.infer<typeof orderViewSchema>;

/** GET /me/orders */
export const myOrdersSchema = z.object({
  orders: z.array(
    z.object({
      id: z.uuid(),
      createdAt: z.iso.datetime(),
      status: orderStatusSchema,
      courseId: z.uuid(),
      courseTitle: z.string(),
      part: orderPartSchema,
      total: moneySchema,
      receiptNumber: z.string().nullable(),
    }),
  ),
});

/** GET /me/orders/{id}/receipt (F27, F48: the school is the seller). */
export const receiptViewSchema = z.object({
  number: z.string(),
  issuedAt: z.iso.datetime(),
  seller: z.object({
    name: z.string(),
    legalName: z.string().nullable(),
    address: z.string().nullable(),
    taxId: z.string().nullable(),
  }),
  buyer: z.object({ name: z.string(), email: z.string() }),
  items: z.array(z.object({ title: z.string(), unitPrice: moneySchema, part: orderPartSchema })),
  total: moneySchema,
  payment: z.object({
    method: paymentMethodSchema,
    network: mobileNetworkSchema.nullable(),
    maskedMsisdn: z.string().nullable(),
    reference: z.string(),
  }),
  refunded: z.boolean(),
});
export type ReceiptView = z.infer<typeof receiptViewSchema>;

// ---------------------------------------------------------------------------------------------
// Administration (05 §4.9: orders, exceptions, refunds, earnings, payouts)
// ---------------------------------------------------------------------------------------------

export const adminOrdersQuerySchema = z.object({
  status: orderStatusSchema.optional(),
  method: paymentMethodSchema.optional(),
  q: z.string().trim().max(100).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const adminOrderRowSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  status: orderStatusSchema,
  buyerName: z.string(),
  buyerEmail: z.string(),
  courseTitle: z.string(),
  part: orderPartSchema,
  total: moneySchema,
  method: paymentMethodSchema.nullable(),
  network: mobileNetworkSchema.nullable(),
  paymentStatus: paymentStatusSchema.nullable(),
  receiptNumber: z.string().nullable(),
});

export const adminOrdersSchema = z.object({ orders: z.array(adminOrderRowSchema) });

export const refundModeSchema = z.enum(['PROVIDER', 'MANUAL']);
export const ledgerTypeSchema = z.enum(['SALE', 'REFUND_REVERSAL', 'ADJUSTMENT']);
export const ledgerStatusSchema = z.enum(['PENDING', 'AVAILABLE', 'PAID', 'FROZEN']);

export const ledgerLineSchema = z.object({
  id: z.uuid(),
  type: ledgerTypeSchema,
  status: ledgerStatusSchema,
  instructorName: z.string(),
  gross: z.number().int(),
  providerFee: z.number().int(),
  commission: z.number().int(),
  net: z.number().int(),
  currency: z.string(),
  availableAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  courseTitle: z.string(),
  payoutId: z.uuid().nullable(),
});
export type LedgerLine = z.infer<typeof ledgerLineSchema>;

export const adminOrderDetailSchema = z.object({
  order: adminOrderRowSchema.extend({
    expiresAt: z.iso.datetime(),
    paidAt: z.iso.datetime().nullable(),
    courseId: z.uuid(),
    enrollmentStatus: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']).nullable(),
    progressPercent: z.number().nullable(),
  }),
  payments: z.array(
    z.object({
      id: z.uuid(),
      reference: z.string(),
      method: paymentMethodSchema,
      network: mobileNetworkSchema.nullable(),
      maskedMsisdn: z.string().nullable(),
      status: paymentStatusSchema,
      amount: moneySchema,
      providerAmount: moneySchema.nullable(),
      failureCode: z.string().nullable(),
      reviewReason: z.string().nullable(),
      createdAt: z.iso.datetime(),
      confirmedAt: z.iso.datetime().nullable(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.uuid(),
      type: z.string(),
      receivedAt: z.iso.datetime(),
      processedAt: z.iso.datetime().nullable(),
      payload: z.unknown(),
    }),
  ),
  refunds: z.array(
    z.object({
      id: z.uuid(),
      mode: refundModeSchema,
      status: z.enum(['PROCESSING', 'SUCCEEDED', 'FAILED']),
      amount: moneySchema,
      reason: z.string(),
      reference: z.string().nullable(),
      createdAt: z.iso.datetime(),
      completedAt: z.iso.datetime().nullable(),
    }),
  ),
  ledger: z.array(ledgerLineSchema),
  /** Refund guidance (F28, Q-BIZ-2): shown to the admin, not enforced. */
  refundGuidance: z.object({
    withinWindow: z.boolean(),
    windowDays: z.number().int(),
    progressPercent: z.number().nullable(),
    refundApi: refundApiSchema,
    defaultMode: refundModeSchema,
  }),
  allowedActions: z.array(z.enum(['refund', 'recheck', 'accept'])),
});
export type AdminOrderDetail = z.infer<typeof adminOrderDetailSchema>;

export const refundRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('PROVIDER'), reason: z.string().trim().min(5).max(500) }),
  z.object({
    mode: z.literal('MANUAL'),
    reason: z.string().trim().min(5).max(500),
    reference: z.string().trim().min(3).max(120),
  }),
]);
export type RefundRequest = z.infer<typeof refundRequestSchema>;

export const resolveExceptionSchema = z.object({
  decision: z.enum(['ACCEPT']),
  note: z.string().trim().min(5).max(500),
});

export const paymentExceptionsSchema = z.object({
  exceptions: z.array(
    z.object({
      paymentId: z.uuid(),
      orderId: z.uuid(),
      createdAt: z.iso.datetime(),
      buyerName: z.string(),
      courseTitle: z.string(),
      amount: moneySchema,
      providerAmount: moneySchema.nullable(),
      reviewReason: z.string(),
    }),
  ),
});

/** S-AD05: instructors with their balances. */
export const adminEarningsSchema = z.object({
  instructors: z.array(
    z.object({
      membershipId: z.uuid(),
      name: z.string(),
      pending: z.number().int(),
      available: z.number().int(),
      paid: z.number().int(),
      currency: z.string(),
      payoutMethodHint: z.string().nullable(),
    }),
  ),
});

export const instructorLedgerSchema = z.object({
  name: z.string(),
  entries: z.array(ledgerLineSchema),
  payoutMethodHint: z.string().nullable(),
});

export const recordPayoutSchema = z.object({
  membershipId: z.uuid(),
  entryIds: z.array(z.uuid()).min(1).max(1000),
  externalReference: z.string().trim().min(3).max(120),
  paidAt: z.iso.date(),
  note: z.string().trim().max(500).optional(),
});

export const payoutViewSchema = z.object({
  id: z.uuid(),
  instructorName: z.string(),
  amount: moneySchema,
  externalReference: z.string(),
  paidAt: z.iso.datetime(),
  methodHint: z.string().nullable(),
  entryCount: z.number().int(),
  note: z.string().nullable(),
});
export const payoutsSchema = z.object({ payouts: z.array(payoutViewSchema) });

/** S-T11: the instructor's own earnings. */
export const myEarningsSchema = z.object({
  currency: z.string(),
  balances: z.object({
    pending: z.number().int(),
    available: z.number().int(),
    paidThisYear: z.number().int(),
  }),
  months: z.array(
    z.object({
      month: z.string(),
      gross: z.number().int(),
      fees: z.number().int(),
      commission: z.number().int(),
      net: z.number().int(),
      entries: z.array(ledgerLineSchema),
    }),
  ),
  payouts: z.array(payoutViewSchema),
  refundWindowDays: z.number().int(),
  commissionBps: z.number().int(),
  payoutSchedule: z.enum(['WEEKLY', 'MONTHLY', 'ON_REQUEST']),
});
export type MyEarnings = z.infer<typeof myEarningsSchema>;

// ---------------------------------------------------------------------------------------------
// Payout methods (S-T12; BR-04 with revenue share)
// ---------------------------------------------------------------------------------------------

export const payoutMethodInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('MOBILE_MONEY'),
    msisdn: z.string().trim().min(9).max(20),
    accountName: z.string().trim().min(2).max(120),
  }),
  z.object({
    type: z.literal('BANK'),
    bankName: z.string().trim().min(2).max(120),
    accountNumber: z
      .string()
      .trim()
      .regex(/^[0-9 -]{6,30}$/),
    accountName: z.string().trim().min(2).max(120),
    branch: z.string().trim().max(120).optional(),
  }),
]);

export const payoutMethodViewSchema = z.object({
  id: z.uuid(),
  type: z.enum(['MOBILE_MONEY', 'BANK']),
  displayHint: z.string(),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const payoutMethodsSchema = z.object({ methods: z.array(payoutMethodViewSchema) });
