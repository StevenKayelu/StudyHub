/**
 * Commerce rules as plain functions (M8; blueprint 05 §3.6, §3.7; BR-08, BR-10, BR-14, BR-15, BR-33,
 * BR-36, BR-55). Amounts are integers in minor units (ngwee); no floating point touches money.
 */

export type PaymentState =
  'INITIATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'NEEDS_REVIEW' | 'REFUNDED';

export type OrderState = 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';

/** The payment state machine of 05 §3.6 (forward only). */
const PAYMENT_TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  INITIATED: ['PENDING', 'FAILED', 'SUCCEEDED', 'NEEDS_REVIEW', 'CANCELLED', 'EXPIRED'],
  PENDING: ['SUCCEEDED', 'NEEDS_REVIEW', 'FAILED', 'EXPIRED', 'CANCELLED'],
  // Late confirmations are honoured (F25 recovery).
  CANCELLED: ['SUCCEEDED', 'NEEDS_REVIEW', 'FAILED', 'EXPIRED'],
  EXPIRED: ['SUCCEEDED', 'NEEDS_REVIEW'],
  // A provider can report a success after a failure it had reported (rare, but money moved).
  FAILED: ['SUCCEEDED', 'NEEDS_REVIEW'],
  SUCCEEDED: ['REFUNDED'],
  NEEDS_REVIEW: ['SUCCEEDED', 'REFUNDED'],
  REFUNDED: [],
};

export function canMovePayment(from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Payments whose final outcome is still open: reconciliation keeps asking the provider about them. */
export function isPaymentOpen(status: PaymentState): boolean {
  return status === 'INITIATED' || status === 'PENDING' || status === 'CANCELLED';
}

/** An order can take a (new) payment while pending and not past its expiry (BR-08, BR-35). */
export function isOrderPayable(order: { status: OrderState; expiresAt: Date }, now: Date): boolean {
  return order.status === 'PENDING' && order.expiresAt > now;
}

/** BR-14: commission is `bps` of gross, rounded half-up to the ngwee. */
export function commissionOf(grossMinor: number, bps: number): number {
  if (!Number.isInteger(grossMinor) || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError('commissionOf needs integer minor units and 0–10000 basis points');
  }
  // Integer half-up: floor((gross × bps × 2 + 10000) / 20000) for non-negative gross.
  const sign = grossMinor < 0 ? -1 : 1;
  const magnitude = Math.abs(grossMinor);
  return sign * Math.floor((magnitude * bps * 2 + 10_000) / 20_000);
}

export interface Split {
  grossMinor: number;
  providerFeeMinor: number;
  commissionMinor: number;
  netMinor: number;
}

/**
 * BR-14: instructor net = gross − provider fee (if attributable) − commission; the instructor gets the
 * remainder, so the four always balance (the database CHECK).
 */
export function saleSplit(grossMinor: number, providerFeeMinor: number | null, commissionBps: number): Split {
  const fee = providerFeeMinor ?? 0;
  if (fee < 0 || fee > grossMinor)
    throw new RangeError('provider fee must be between 0 and the gross amount');
  const commissionMinor = commissionOf(grossMinor, commissionBps);
  return { grossMinor, providerFeeMinor: fee, commissionMinor, netMinor: grossMinor - fee - commissionMinor };
}

/** A refund reverses the whole sale (full refunds only): every amount negated. */
export function reversalOf(sale: Split): Split {
  return {
    grossMinor: -sale.grossMinor,
    providerFeeMinor: -sale.providerFeeMinor,
    commissionMinor: -sale.commissionMinor,
    netMinor: -sale.netMinor,
  };
}

export type LedgerState = 'PENDING' | 'AVAILABLE' | 'PAID' | 'FROZEN';

/**
 * Where a reversal starts (W4): with an unpaid sale it shares the sale's fate (pending with it, available
 * with it), so the two cancel out; after the sale was paid out it is available at once, which leaves a
 * negative balance carried into the next payout (07 M8 AC 7).
 */
export function reversalPlacement(
  sale: { status: LedgerState; availableAt: Date },
  now: Date,
): { status: LedgerState; availableAt: Date } {
  if (sale.status === 'PENDING' || sale.status === 'FROZEN') {
    return { status: sale.status, availableAt: sale.availableAt };
  }
  return { status: 'AVAILABLE', availableAt: now };
}

/** BR-15: a sale becomes available after the school's refund window. */
export function availableAtFor(paidAt: Date, refundWindowDays: number): Date {
  return new Date(paidAt.getTime() + refundWindowDays * 86_400_000);
}

export interface PayoutEntry {
  id: string;
  status: LedgerState;
  netMinor: number;
  availableAt: Date;
}

export type PayoutProblem =
  | { code: 'UNKNOWN_ENTRY'; entryId: string }
  | { code: 'NOT_AVAILABLE'; entryId: string }
  | { code: 'NEGATIVE_LEFT_OUT'; entryIds: string[] }
  | { code: 'NOT_POSITIVE'; totalMinor: number };

/**
 * W3: a payout takes available entries of one instructor. Every available negative entry (a refund
 * after an earlier payout) must be included, and the total must be positive (AC 7, PROPOSED 6).
 * `available` holds all the instructor's entries that are available now.
 */
export function checkPayout(
  selectedIds: readonly string[],
  available: readonly PayoutEntry[],
): { ok: true; totalMinor: number } | { ok: false; problem: PayoutProblem } {
  const byId = new Map(available.map((entry) => [entry.id, entry]));
  let total = 0;
  for (const id of new Set(selectedIds)) {
    const entry = byId.get(id);
    if (entry === undefined) return { ok: false, problem: { code: 'UNKNOWN_ENTRY', entryId: id } };
    if (entry.status !== 'AVAILABLE') return { ok: false, problem: { code: 'NOT_AVAILABLE', entryId: id } };
    total += entry.netMinor;
  }
  const selected = new Set(selectedIds);
  const leftOut = available.filter((entry) => entry.netMinor < 0 && !selected.has(entry.id)).map((e) => e.id);
  if (leftOut.length > 0) return { ok: false, problem: { code: 'NEGATIVE_LEFT_OUT', entryIds: leftOut } };
  if (total <= 0) return { ok: false, problem: { code: 'NOT_POSITIVE', totalMinor: total } };
  return { ok: true, totalMinor: total };
}

/** Balances for S-T11 and S-AD05. Pending entries past their date count as available (release lag). */
export function balances(
  entries: readonly { status: LedgerState; netMinor: number; availableAt: Date; paidAt?: Date | null }[],
  now: Date,
  yearStart: Date,
): { pending: number; available: number; paid: number; paidThisYear: number } {
  let pending = 0;
  let available = 0;
  let paid = 0;
  let paidThisYear = 0;
  for (const entry of entries) {
    if (entry.status === 'PAID') {
      paid += entry.netMinor;
      if (entry.paidAt !== undefined && entry.paidAt !== null && entry.paidAt >= yearStart) {
        paidThisYear += entry.netMinor;
      }
    } else if (entry.status === 'AVAILABLE' || (entry.status === 'PENDING' && entry.availableAt <= now)) {
      available += entry.netMinor;
    } else if (entry.status === 'PENDING') {
      pending += entry.netMinor;
    }
  }
  return { pending, available, paid, paidThisYear };
}

/**
 * W5: when to ask the provider again. First check 2 min after the start, then doubling (4, 8, 16 … min)
 * capped at 6 h between checks; after 24 h without a final status the payment expires (null).
 */
export function nextCheckDelayMs(checkCount: number, startedAt: Date, now: Date): number | null {
  const MINUTE = 60_000;
  const deadline = startedAt.getTime() + 24 * 60 * MINUTE;
  if (now.getTime() >= deadline) return null;
  const delay = Math.min(2 * MINUTE * 2 ** Math.max(0, checkCount), 6 * 60 * MINUTE);
  return Math.min(delay, Math.max(deadline - now.getTime(), MINUTE));
}

/** BR-55: `{PREFIX}-{year}-{seq:06}`. */
export function receiptNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(6, '0')}`;
}

/** A receipt prefix from the school's slug when none is set: up to 8 letters and digits, upper case. */
export function prefixFromSlug(slug: string): string {
  const letters = slug
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 8);
  return letters.length >= 2 ? letters : `${letters}SH`.slice(0, 8);
}

/**
 * BR-10 / BR-11: what a provider-confirmed success means for this order. `null` when it can be granted.
 */
export function successProblem(input: {
  orderStatus: OrderState;
  orderAmountMinor: number;
  orderCurrency: string;
  paidAmountMinor: number;
  paidCurrency: string;
  alreadyEnrolled: boolean;
}): 'AMOUNT_MISMATCH' | 'ALREADY_PAID' | 'ALREADY_ENROLLED' | 'ORDER_CLOSED' | null {
  if (input.paidAmountMinor !== input.orderAmountMinor || input.paidCurrency !== input.orderCurrency) {
    return 'AMOUNT_MISMATCH';
  }
  if (input.orderStatus === 'PAID' || input.orderStatus === 'REFUNDED') return 'ALREADY_PAID';
  if (input.alreadyEnrolled) return 'ALREADY_ENROLLED';
  // A cancelled order whose payment still went through: the learner paid, so it is reviewed.
  if (input.orderStatus === 'CANCELLED') return 'ORDER_CLOSED';
  return null;
}

/** F28 guidance (Q-BIZ-2): within the window and at most 30 % progress. Shown, not enforced. */
export function refundWithinGuidance(
  paidAt: Date | null,
  progressPercent: number | null,
  windowDays: number,
  now: Date,
): boolean {
  if (paidAt === null) return false;
  const inWindow = now.getTime() - paidAt.getTime() <= windowDays * 86_400_000;
  return inWindow && (progressPercent ?? 0) <= 30;
}

/** "K250.00" (ZMW) or "USD 12.50", for emails and logs; the web formats with the viewer's locale. */
export function formatAmount(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? '-' : '';
  const absolute = Math.abs(amountMinor);
  const units = Math.floor(absolute / 100).toLocaleString('en-US');
  const cents = String(absolute % 100).padStart(2, '0');
  return `${sign}${currency === 'ZMW' ? 'K' : `${currency} `}${units}.${cents}`;
}
