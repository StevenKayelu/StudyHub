import type { PaymentCapabilities } from '@studyhub/contracts';
import { describe, expect, it } from 'vitest';

import { offeredMethods, refundModeFor, settingsProblems } from './capability-rules';

const caps = (change: Partial<PaymentCapabilities> = {}): PaymentCapabilities => ({
  mobileMoney: { networks: ['MTN', 'AIRTEL', 'ZAMTEL'] },
  card: true,
  refundApi: 'FULL',
  statusQuery: true,
  transactionListApi: false,
  disbursementApi: false,
  currencies: ['ZMW'],
  webhookSigning: 'HMAC_SHA256',
  ...change,
});

describe('capability-limited payment settings (BR-62, 07 M8 AC 5)', () => {
  it('accepts what the account supports', () => {
    expect(
      settingsProblems(
        { enabledPaymentMethods: ['MOBILE_MONEY', 'CARD'], refundMode: 'PROVIDER_API' },
        caps(),
      ),
    ).toEqual([]);
  });

  it('refuses methods the account does not support', () => {
    const problems = settingsProblems(
      { enabledPaymentMethods: ['MOBILE_MONEY', 'CARD'], refundMode: 'MANUAL' },
      caps({ card: false }),
    );
    expect(problems.map((p) => p.field)).toEqual(['enabledPaymentMethods']);
    expect(problems[0]?.message).toContain('CARD');
  });

  it('refuses the provider refund mode without a refund API, or without an account', () => {
    expect(
      settingsProblems(
        { enabledPaymentMethods: [], refundMode: 'PROVIDER_API' },
        caps({ refundApi: 'NONE' }),
      ),
    ).toHaveLength(1);
    expect(settingsProblems({ enabledPaymentMethods: [], refundMode: 'PROVIDER_API' }, null)).toHaveLength(1);
    expect(settingsProblems({ enabledPaymentMethods: ['CARD'], refundMode: 'MANUAL' }, null)).toEqual([]);
  });

  it('checkout offers the intersection, with the account’s networks', () => {
    expect(offeredMethods(['MOBILE_MONEY', 'CARD'], caps({ card: false }))).toEqual({
      methods: ['MOBILE_MONEY'],
      networks: ['MTN', 'AIRTEL', 'ZAMTEL'],
    });
    expect(offeredMethods(['CARD'], caps())).toEqual({ methods: ['CARD'], networks: [] });
    expect(offeredMethods(['MOBILE_MONEY'], caps({ mobileMoney: null }))).toEqual({
      methods: [],
      networks: [],
    });
    expect(offeredMethods(['MOBILE_MONEY', 'CARD'], null)).toEqual({ methods: [], networks: [] });
  });

  it('refunds go through the provider only when chosen and possible (manual fallback, AC 6)', () => {
    expect(refundModeFor('PROVIDER_API', caps())).toBe('PROVIDER');
    expect(refundModeFor('PROVIDER_API', caps({ refundApi: 'PARTIAL' }))).toBe('PROVIDER');
    expect(refundModeFor('PROVIDER_API', caps({ refundApi: 'NONE' }))).toBe('MANUAL');
    expect(refundModeFor('MANUAL', caps())).toBe('MANUAL');
  });
});
