import { createHmac } from 'node:crypto';

import { FAKE_PROFILES, supportedMethods } from '@studyhub/contracts';
import { describe, expect, it } from 'vitest';

import { DEV_PAYMENT_ENCRYPTION_KEY } from '../../platform';
import { offeredMethods, refundModeFor, settingsProblems } from '../domain/capability-rules';
import {
  FAKE_PAY_SIGNATURE_HEADER,
  FAKE_PROFILE_CAPABILITIES,
  FakePaymentProvider,
} from './fake-payment-provider';
import { PaymentVault } from './payment-vault';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const ACCOUNT = '00000000-0000-4000-8000-0000000000c1';

describe('payment vault (04 §17.10 envelope encryption)', () => {
  const vault = new PaymentVault(DEV_PAYMENT_ENCRYPTION_KEY);
  const credentials = { merchantId: 'merchant-1234', apiKey: 'fixture-live-key-SECRET-123' };

  it('round-trips an account’s credentials and webhook secret; nothing is stored in plain text', () => {
    const sealed = vault.sealAccount(TENANT_A, ACCOUNT, credentials, 'whsec-SECRET-abcdefgh');
    const stored = Buffer.concat([
      sealed.credentialsEnc,
      sealed.webhookSecretEnc,
      sealed.dataKeyEnc,
    ]).toString('latin1');
    expect(stored).not.toContain('SECRET');
    expect(stored).not.toContain('merchant-1234');
    expect(vault.openAccount(TENANT_A, { id: ACCOUNT, ...sealed })).toEqual({
      credentials,
      webhookSecret: 'whsec-SECRET-abcdefgh',
    });
  });

  it('a sealed account can’t be opened as another school’s or another account’s', () => {
    const sealed = vault.sealAccount(TENANT_A, ACCOUNT, credentials, 'whsec-SECRET-abcdefgh');
    expect(() => vault.openAccount(TENANT_B, { id: ACCOUNT, ...sealed })).toThrow();
    expect(() =>
      vault.openAccount(TENANT_A, { id: '00000000-0000-4000-8000-0000000000c2', ...sealed }),
    ).toThrow();
    // Each account has its own data key: the same secret seals differently.
    const again = vault.sealAccount(TENANT_A, ACCOUNT, credentials, 'whsec-SECRET-abcdefgh');
    expect(Buffer.from(again.dataKeyEnc).equals(Buffer.from(sealed.dataKeyEnc))).toBe(false);
  });

  it('payer numbers are bound to their school and purpose', () => {
    const sealed = vault.sealValue(TENANT_A, 'msisdn', '+260971234567');
    expect(vault.openValue(TENANT_A, 'msisdn', sealed)).toBe('+260971234567');
    expect(() => vault.openValue(TENANT_B, 'msisdn', sealed)).toThrow();
    expect(() => vault.openValue(TENANT_A, 'payout-details', sealed)).toThrow();
  });
});

describe('fake adapter capability matrix (07 M8 AC 8, BR-62)', () => {
  const fake = new FakePaymentProvider(null as never);

  it.each(FAKE_PROFILES)('profile %s: settings, checkout and refunds follow its capabilities', (profile) => {
    const caps = FAKE_PROFILE_CAPABILITIES[profile];
    const supported = supportedMethods(caps);
    // Settings accept exactly the supported methods and refuse the others.
    expect(settingsProblems({ enabledPaymentMethods: supported, refundMode: 'MANUAL' }, caps)).toEqual([]);
    const unsupported = (['MOBILE_MONEY', 'CARD'] as const).filter((m) => !supported.includes(m));
    if (unsupported.length > 0) {
      expect(
        settingsProblems({ enabledPaymentMethods: [...unsupported], refundMode: 'MANUAL' }, caps),
      ).toHaveLength(1);
    }
    // Checkout offers the intersection only.
    expect(offeredMethods(['MOBILE_MONEY', 'CARD'], caps).methods).toEqual(supported);
    // The provider refund mode only where there is a refund API; otherwise manual refunds.
    const providerRefunds = caps.refundApi !== 'NONE';
    expect(settingsProblems({ enabledPaymentMethods: [], refundMode: 'PROVIDER_API' }, caps)).toHaveLength(
      providerRefunds ? 0 : 1,
    );
    expect(refundModeFor('PROVIDER_API', caps)).toBe(providerRefunds ? 'PROVIDER' : 'MANUAL');
  });

  it('the profiles cover every combination the settings depend on', () => {
    const combos = new Set(
      FAKE_PROFILES.map((p) => {
        const caps = FAKE_PROFILE_CAPABILITIES[p];
        return `${supportedMethods(caps).join('+')}|${caps.refundApi}`;
      }),
    );
    expect(combos).toEqual(
      new Set([
        'MOBILE_MONEY+CARD|FULL',
        'MOBILE_MONEY|FULL',
        'CARD|FULL',
        'MOBILE_MONEY+CARD|NONE',
        'MOBILE_MONEY+CARD|PARTIAL',
      ]),
    );
  });

  it('validates credentials and never puts the secret in the hint', () => {
    const parsed = fake.parseCredentials({
      merchantId: 'merchant-9876',
      apiKey: 'fixture-key-123456789',
      webhookSecret: 'fixture-whsec-0123456789abcdef',
      profile: 'MOBILE_ONLY',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.maskedHint).toBe('Fake provider · merchant ••••9876 · MOBILE_ONLY');
    expect(parsed.value.credentials).not.toHaveProperty('webhookSecret');
    expect(fake.parseCredentials({ merchantId: 'x' }).ok).toBe(false);
  });

  it('verifies webhook signatures over the raw body with the account’s secret, in constant time', () => {
    const body = Buffer.from(JSON.stringify({ eventId: 'ev_1', type: 'payment.updated', reference: 'r' }));
    const signature = createHmac('sha256', 'secret-A-0123456789').update(body).digest('hex');
    expect(
      fake.verifyWebhook(body, { [FAKE_PAY_SIGNATURE_HEADER]: signature }, 'secret-A-0123456789'),
    ).toMatchObject({
      eventId: 'ev_1',
      reference: 'r',
    });
    expect(
      fake.verifyWebhook(body, { [FAKE_PAY_SIGNATURE_HEADER]: signature }, 'secret-B-0123456789'),
    ).toBeNull();
    expect(
      fake.verifyWebhook(
        Buffer.from(`${body.toString()} `),
        { [FAKE_PAY_SIGNATURE_HEADER]: signature },
        'secret-A-0123456789',
      ),
    ).toBeNull();
    expect(fake.verifyWebhook(body, {}, 'secret-A-0123456789')).toBeNull();
  });
});
