/**
 * W8, BR-63: the platform's monthly statement for one school. Commission is charged on recorded sales
 * net of refunds (never below zero), rounded half-up to the minor unit; the subscription fee comes from
 * the plan. Framework-free.
 */
export interface StatementInput {
  subscriptionFeeMinor: bigint;
  salesGrossMinor: bigint;
  refundsMinor: bigint;
  commissionBps: number;
}

export interface StatementAmounts {
  subscriptionFeeMinor: bigint;
  commissionBaseMinor: bigint;
  commissionMinor: bigint;
  totalDueMinor: bigint;
}

export function platformCommission(input: StatementInput): StatementAmounts {
  if (!Number.isInteger(input.commissionBps) || input.commissionBps < 0 || input.commissionBps > 10_000) {
    throw new RangeError('commissionBps must be an integer between 0 and 10000');
  }
  const base = input.salesGrossMinor - input.refundsMinor;
  const commissionBaseMinor = base > 0n ? base : 0n;
  // Half-up: (base × bps + 5000) / 10000, in integers.
  const commissionMinor = (commissionBaseMinor * BigInt(input.commissionBps) + 5000n) / 10_000n;
  return {
    subscriptionFeeMinor: input.subscriptionFeeMinor,
    commissionBaseMinor,
    commissionMinor,
    totalDueMinor: input.subscriptionFeeMinor + commissionMinor,
  };
}
