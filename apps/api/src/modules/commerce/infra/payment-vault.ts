import { randomBytes } from 'node:crypto';

import { SecretBox } from '../../platform';

/** What Prisma stores in a `Bytes` column. */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface SealedAccount {
  credentialsEnc: Bytes;
  webhookSecretEnc: Bytes;
  dataKeyEnc: Bytes;
}

const bytes = (buffer: Buffer): Bytes => new Uint8Array(buffer);
const buf = (value: Uint8Array): Buffer => Buffer.from(value.buffer, value.byteOffset, value.byteLength);

/**
 * Envelope encryption for school payment accounts (04 §17.10, ADR-019). Each account has its own random
 * data key (AES-256-GCM); the data key is sealed by the key-encryption key (PAYMENT_ENCRYPTION_KEY, a
 * KMS-managed key later). The school and account ids are bound as additional data, so a sealed value
 * copied to another account or school can't be opened. Payer numbers and payout details are sealed
 * directly with the key-encryption key, bound to their school and purpose.
 */
export class PaymentVault {
  private readonly kek: SecretBox;

  constructor(kekBase64: string) {
    this.kek = new SecretBox(kekBase64);
  }

  sealAccount(
    tenantId: string,
    accountId: string,
    credentials: Record<string, unknown>,
    webhookSecret: string,
  ): SealedAccount {
    const dataKey = randomBytes(32);
    try {
      const box = new SecretBox(dataKey.toString('base64'));
      return {
        credentialsEnc: bytes(
          box.seal(JSON.stringify(credentials), context(tenantId, accountId, 'credentials')),
        ),
        webhookSecretEnc: bytes(box.seal(webhookSecret, context(tenantId, accountId, 'webhook-secret'))),
        dataKeyEnc: bytes(this.kek.seal(dataKey, context(tenantId, accountId, 'data-key'))),
      };
    } finally {
      dataKey.fill(0);
    }
  }

  openAccount(
    tenantId: string,
    account: { id: string; credentialsEnc: Uint8Array; webhookSecretEnc: Uint8Array; dataKeyEnc: Uint8Array },
  ): { credentials: Record<string, unknown>; webhookSecret: string } {
    const dataKey = this.kek.open(buf(account.dataKeyEnc), context(tenantId, account.id, 'data-key'));
    try {
      const box = new SecretBox(dataKey.toString('base64'));
      return {
        credentials: JSON.parse(
          box
            .open(buf(account.credentialsEnc), context(tenantId, account.id, 'credentials'))
            .toString('utf8'),
        ) as Record<string, unknown>,
        webhookSecret: box
          .open(buf(account.webhookSecretEnc), context(tenantId, account.id, 'webhook-secret'))
          .toString('utf8'),
      };
    } finally {
      dataKey.fill(0);
    }
  }

  /** A payer's number or an instructor's payout details. */
  sealValue(tenantId: string, purpose: 'msisdn' | 'payout-details', value: string): Bytes {
    return bytes(this.kek.seal(value, `studyhub:payments:${tenantId}:${purpose}`));
  }

  openValue(tenantId: string, purpose: 'msisdn' | 'payout-details', sealed: Uint8Array): string {
    return this.kek.open(buf(sealed), `studyhub:payments:${tenantId}:${purpose}`).toString('utf8');
  }
}

const context = (tenantId: string, accountId: string, part: string) =>
  `studyhub:payment-account:${tenantId}:${accountId}:${part}`;
