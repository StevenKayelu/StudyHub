import { describe, expect, it } from 'vitest';

import {
  availableAtFor,
  balances,
  canMovePayment,
  checkPayout,
  commissionOf,
  formatAmount,
  isOrderPayable,
  nextCheckDelayMs,
  prefixFromSlug,
  receiptNumber,
  refundWithinGuidance,
  reversalOf,
  reversalPlacement,
  saleSplit,
  successProblem,
} from './money-rules';

const MINUTE = 60_000;
const DAY = 86_400_000;

describe('commission and split (BR-14)', () => {
  it.each([
    // gross, bps, commission
    [25_000, 2000, 5000],
    [1, 2000, 0], // 0.2 → 0
    [3, 2000, 1], // 0.6 → 1
    [5, 1000, 1], // 0.5 → 1 (half-up)
    [15, 1000, 2], // 1.5 → 2
    [25, 1000, 3], // 2.5 → 3
    [24_999, 1250, 3125], // 3124.875 → 3125
    [10_000, 0, 0],
    [10_000, 10_000, 10_000],
    [-25, 1000, -3], // reversals mirror the sale
  ])('commission of %i at %i bps is %i', (gross, bps, expected) => {
    expect(commissionOf(gross, bps)).toBe(expected);
  });

  it('rejects fractions and out-of-range rates', () => {
    expect(() => commissionOf(10.5, 2000)).toThrow(RangeError);
    expect(() => commissionOf(100, 10_001)).toThrow(RangeError);
    expect(() => commissionOf(100, -1)).toThrow(RangeError);
  });

  it('the instructor gets the remainder, so the split always balances', () => {
    for (const [gross, fee, bps] of [
      [25_000, 625, 2000],
      [1999, null, 1750],
      [7, 1, 3333],
      [100_000_000, 2_500_000, 1],
    ] as const) {
      const split = saleSplit(gross, fee, bps);
      expect(split.grossMinor - split.providerFeeMinor - split.commissionMinor).toBe(split.netMinor);
      expect(split.providerFeeMinor).toBe(fee ?? 0);
    }
    expect(saleSplit(25_000, 625, 2000)).toEqual({
      grossMinor: 25_000,
      providerFeeMinor: 625,
      commissionMinor: 5000,
      netMinor: 19_375,
    });
  });

  it('refuses a fee larger than the sale', () => {
    expect(() => saleSplit(100, 101, 0)).toThrow(RangeError);
  });

  it('a reversal negates every amount and still balances', () => {
    const reversal = reversalOf(saleSplit(25_000, 625, 2000));
    expect(reversal).toEqual({
      grossMinor: -25_000,
      providerFeeMinor: -625,
      commissionMinor: -5000,
      netMinor: -19_375,
    });
  });
});

describe('ledger timing (BR-15, W4, AC 7)', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  it('a sale becomes available after the refund window', () => {
    expect(availableAtFor(now, 7).getTime() - now.getTime()).toBe(7 * DAY);
    expect(availableAtFor(now, 0)).toEqual(now);
  });

  it('a reversal shares an unpaid sale’s fate, and is available at once after a payout', () => {
    const later = new Date(now.getTime() + 7 * DAY);
    expect(reversalPlacement({ status: 'PENDING', availableAt: later }, now)).toEqual({
      status: 'PENDING',
      availableAt: later,
    });
    expect(reversalPlacement({ status: 'AVAILABLE', availableAt: now }, later)).toEqual({
      status: 'AVAILABLE',
      availableAt: later,
    });
    expect(reversalPlacement({ status: 'PAID', availableAt: now }, later)).toEqual({
      status: 'AVAILABLE',
      availableAt: later,
    });
  });

  it('balances count due pending entries as available, and paid ones by year', () => {
    const yearStart = new Date('2026-01-01T00:00:00Z');
    const result = balances(
      [
        { status: 'PENDING', netMinor: 100, availableAt: new Date(now.getTime() + DAY) },
        { status: 'PENDING', netMinor: 200, availableAt: new Date(now.getTime() - DAY) },
        { status: 'AVAILABLE', netMinor: 300, availableAt: now },
        { status: 'AVAILABLE', netMinor: -50, availableAt: now },
        { status: 'PAID', netMinor: 400, availableAt: now, paidAt: new Date('2026-03-01T00:00:00Z') },
        { status: 'PAID', netMinor: 500, availableAt: now, paidAt: new Date('2025-12-01T00:00:00Z') },
        { status: 'FROZEN', netMinor: 600, availableAt: now },
      ],
      now,
      yearStart,
    );
    expect(result).toEqual({ pending: 100, available: 450, paid: 900, paidThisYear: 400 });
  });
});

describe('payouts (W3, AC 7)', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  const entry = (id: string, netMinor: number, status: 'AVAILABLE' | 'PENDING' = 'AVAILABLE') => ({
    id,
    netMinor,
    status,
    availableAt: at,
  });

  it('records the sum of the selected available entries', () => {
    expect(checkPayout(['a', 'b'], [entry('a', 1000), entry('b', 500)])).toEqual({
      ok: true,
      totalMinor: 1500,
    });
    expect(checkPayout(['a', 'a'], [entry('a', 1000)])).toEqual({ ok: true, totalMinor: 1000 });
  });

  it('refuses unknown, unavailable and non-positive selections', () => {
    expect(checkPayout(['x'], [entry('a', 1000)])).toEqual({
      ok: false,
      problem: { code: 'UNKNOWN_ENTRY', entryId: 'x' },
    });
    expect(checkPayout(['a'], [entry('a', 1000, 'PENDING')])).toEqual({
      ok: false,
      problem: { code: 'NOT_AVAILABLE', entryId: 'a' },
    });
    expect(checkPayout(['a', 'n'], [entry('a', 100), entry('n', -300)])).toEqual({
      ok: false,
      problem: { code: 'NOT_POSITIVE', totalMinor: -200 },
    });
  });

  it('a negative balance must be carried into the next payout', () => {
    expect(checkPayout(['a'], [entry('a', 1000), entry('n', -300)])).toEqual({
      ok: false,
      problem: { code: 'NEGATIVE_LEFT_OUT', entryIds: ['n'] },
    });
    expect(checkPayout(['a', 'n'], [entry('a', 1000), entry('n', -300)])).toEqual({
      ok: true,
      totalMinor: 700,
    });
  });
});

describe('payment and order states (05 §3.6, BR-08, BR-10, BR-11)', () => {
  it('moves only forward, honouring late successes', () => {
    expect(canMovePayment('PENDING', 'SUCCEEDED')).toBe(true);
    expect(canMovePayment('CANCELLED', 'SUCCEEDED')).toBe(true);
    expect(canMovePayment('EXPIRED', 'SUCCEEDED')).toBe(true);
    expect(canMovePayment('NEEDS_REVIEW', 'SUCCEEDED')).toBe(true);
    expect(canMovePayment('SUCCEEDED', 'PENDING')).toBe(false);
    expect(canMovePayment('SUCCEEDED', 'FAILED')).toBe(false);
    expect(canMovePayment('REFUNDED', 'SUCCEEDED')).toBe(false);
  });

  it('an order is payable while pending and before its expiry', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    expect(isOrderPayable({ status: 'PENDING', expiresAt: new Date(now.getTime() + MINUTE) }, now)).toBe(
      true,
    );
    expect(isOrderPayable({ status: 'PENDING', expiresAt: now }, now)).toBe(false);
    expect(isOrderPayable({ status: 'PAID', expiresAt: new Date(now.getTime() + MINUTE) }, now)).toBe(false);
  });

  const base = {
    orderStatus: 'PENDING' as const,
    orderAmountMinor: 25_000,
    orderCurrency: 'ZMW',
    paidAmountMinor: 25_000,
    paidCurrency: 'ZMW',
    alreadyEnrolled: false,
  };

  it.each([
    [{}, null],
    [{ orderStatus: 'EXPIRED' as const }, null],
    [{ paidAmountMinor: 24_900 }, 'AMOUNT_MISMATCH'],
    [{ paidCurrency: 'USD' }, 'AMOUNT_MISMATCH'],
    [{ orderStatus: 'PAID' as const }, 'ALREADY_PAID'],
    [{ orderStatus: 'REFUNDED' as const }, 'ALREADY_PAID'],
    [{ alreadyEnrolled: true }, 'ALREADY_ENROLLED'],
    [{ orderStatus: 'CANCELLED' as const }, 'ORDER_CLOSED'],
  ])('success on %o → %s', (change, expected) => {
    expect(successProblem({ ...base, ...change })).toBe(expected);
  });
});

describe('reconciliation schedule (W5)', () => {
  const start = new Date('2026-10-15T12:00:00Z');

  it('first after 2 min, then doubling, capped at 6 h, and nothing after 24 h', () => {
    expect(nextCheckDelayMs(0, start, start)).toBe(2 * MINUTE);
    expect(nextCheckDelayMs(1, start, start)).toBe(4 * MINUTE);
    expect(nextCheckDelayMs(3, start, start)).toBe(16 * MINUTE);
    expect(nextCheckDelayMs(20, start, start)).toBe(6 * 60 * MINUTE);
    const late = new Date(start.getTime() + 23.5 * 60 * MINUTE);
    expect(nextCheckDelayMs(20, start, late)).toBe(30 * MINUTE);
    expect(nextCheckDelayMs(0, start, new Date(start.getTime() + DAY))).toBeNull();
  });
});

describe('receipts (BR-33, BR-55) and refund guidance (F28)', () => {
  it('numbers are prefix-year-sequence', () => {
    expect(receiptNumber('ACME', 2026, 123)).toBe('ACME-2026-000123');
    expect(receiptNumber('B2', 2027, 1_234_567)).toBe('B2-2027-1234567');
  });

  it('a prefix comes from the slug when none is set', () => {
    expect(prefixFromSlug('acme')).toBe('ACME');
    expect(prefixFromSlug('north-ridge-academy')).toBe('NORTHRID');
    expect(prefixFromSlug('a-1')).toBe('A1');
  });

  it('guidance: within the window and at most 30 % progress', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    expect(refundWithinGuidance(new Date(now.getTime() - 6 * DAY), 30, 7, now)).toBe(true);
    expect(refundWithinGuidance(new Date(now.getTime() - 8 * DAY), 0, 7, now)).toBe(false);
    expect(refundWithinGuidance(new Date(now.getTime() - DAY), 31, 7, now)).toBe(false);
    expect(refundWithinGuidance(null, 0, 7, now)).toBe(false);
  });
});

describe('amounts in emails', () => {
  it.each([
    [25_000, 'ZMW', 'K250.00'],
    [5, 'ZMW', 'K0.05'],
    [123_456_789, 'ZMW', 'K1,234,567.89'],
    [-19_375, 'ZMW', '-K193.75'],
    [1250, 'USD', 'USD 12.50'],
  ])('%i %s → %s', (amount, currency, expected) => {
    expect(formatAmount(amount, currency)).toBe(expected);
  });
});
