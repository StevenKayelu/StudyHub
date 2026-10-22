/**
 * Money arithmetic for SaaS billing (docs/design/saas-billing.md §5.1). Amounts are integer minor
 * units in `bigint`; nothing is ever a binary float. Every division rounds half up (away from zero for
 * positive values) to the minor unit, at the line it is computed for.
 */

/** a × numerator ÷ denominator, rounded half up. Inputs must be non-negative; the denominator positive. */
export function mulDivHalfUp(a: bigint, numerator: bigint, denominator: bigint): bigint {
  if (a < 0n || numerator < 0n) throw new RangeError('mulDivHalfUp takes non-negative values');
  if (denominator <= 0n) throw new RangeError('The denominator must be positive');
  return (a * numerator * 2n + denominator) / (denominator * 2n);
}

/** a × bps ÷ 10 000, rounded half up. */
export function applyBps(a: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError('bps must be 0–10000');
  return mulDivHalfUp(a, BigInt(bps), 10_000n);
}

export const max0 = (value: bigint): bigint => (value > 0n ? value : 0n);
export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** "K1,482.90" (ZMW) or "USD 12.50", for emails; bigint-safe. */
export function formatMinor(amountMinor: bigint, currency: string): string {
  const sign = amountMinor < 0n ? '-' : '';
  const absolute = amountMinor < 0n ? -amountMinor : amountMinor;
  const units = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (absolute % 100n).toString().padStart(2, '0');
  return `${sign}${currency === 'ZMW' ? 'K' : `${currency} `}${units}.${cents}`;
}
