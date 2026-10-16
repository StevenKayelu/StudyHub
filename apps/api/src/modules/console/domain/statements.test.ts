import { describe, expect, it } from 'vitest';

import { platformCommission } from './statements';

describe('platform statements (W8, BR-63)', () => {
  it('charges the fee plus commission on sales net of refunds', () => {
    expect(
      platformCommission({
        subscriptionFeeMinor: 50_000n,
        salesGrossMinor: 100_000n,
        refundsMinor: 25_000n,
        commissionBps: 500,
      }),
    ).toEqual({
      subscriptionFeeMinor: 50_000n,
      commissionBaseMinor: 75_000n,
      commissionMinor: 3_750n,
      totalDueMinor: 53_750n,
    });
  });

  it('rounds half up to the ngwee', () => {
    expect(
      platformCommission({
        subscriptionFeeMinor: 0n,
        salesGrossMinor: 25_010n,
        refundsMinor: 0n,
        commissionBps: 250,
      }).commissionMinor,
    ).toBe(625n);
    expect(
      platformCommission({
        subscriptionFeeMinor: 0n,
        salesGrossMinor: 25_030n,
        refundsMinor: 0n,
        commissionBps: 250,
      }).commissionMinor,
    ).toBe(626n);
  });

  it('never charges commission on a month with more refunds than sales', () => {
    const result = platformCommission({
      subscriptionFeeMinor: 10_000n,
      salesGrossMinor: 1_000n,
      refundsMinor: 5_000n,
      commissionBps: 1000,
    });
    expect(result.commissionMinor).toBe(0n);
    expect(result.totalDueMinor).toBe(10_000n);
  });

  it('defaults to no commission (bps 0) and rejects invalid rates', () => {
    expect(
      platformCommission({
        subscriptionFeeMinor: 0n,
        salesGrossMinor: 99_999n,
        refundsMinor: 0n,
        commissionBps: 0,
      }).totalDueMinor,
    ).toBe(0n);
    expect(() =>
      platformCommission({
        subscriptionFeeMinor: 0n,
        salesGrossMinor: 1n,
        refundsMinor: 0n,
        commissionBps: 10_001,
      }),
    ).toThrow(RangeError);
  });
});
