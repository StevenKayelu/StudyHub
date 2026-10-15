import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { type FakeCredentials, fakeCredentialsSchema, type PaymentCapabilities } from '@studyhub/contracts';

import type { PrismaClient } from '../../../generated/prisma/client';
import { commissionOf } from '../domain/money-rules';
import {
  type CredentialsResult,
  type PaymentProvider,
  type ProviderAccount,
  type ProviderEvent,
  type ProviderStatus,
  ProviderUnavailableError,
  type RefundResult,
  type StartPaymentInput,
  type StartPaymentResult,
} from './payment-provider';

/** Signature header of the fake provider: hex HMAC-SHA256 of the raw body with the account's secret. */
export const FAKE_PAY_SIGNATURE_HEADER = 'x-fake-pay-signature';
/** The fake provider's hosted card page (development only). */
export const FAKE_PAY_PATH = '/api/v1/dev/fake-pay';

const ALL_NETWORKS = ['MTN', 'AIRTEL', 'ZAMTEL'] as const;
const base: PaymentCapabilities = {
  mobileMoney: { networks: [...ALL_NETWORKS] },
  card: true,
  refundApi: 'FULL',
  statusQuery: true,
  transactionListApi: false,
  disbursementApi: false,
  currencies: ['ZMW'],
  webhookSigning: 'HMAC_SHA256',
};

/** Every capability combination the fake can simulate (07 M8 AC 8). */
export const FAKE_PROFILE_CAPABILITIES: Readonly<Record<FakeCredentials['profile'], PaymentCapabilities>> = {
  FULL: { ...base, transactionListApi: true },
  MOBILE_ONLY: { ...base, card: false },
  CARD_ONLY: { ...base, mobileMoney: null },
  NO_REFUND_API: { ...base, refundApi: 'NONE' },
  PARTIAL_REFUND: { ...base, refundApi: 'PARTIAL' },
};

/** The fake's simulated fee: 2.5 % of the paid amount (real providers report their own). */
const FEE_BPS = 250;

/**
 * Sandbox numbers (the last four digits) script outcomes that need no simulated phone:
 * 1111 approved at once, 2222 insufficient funds, 3333 declined, 4444 never answered,
 * 5555 approved for K1.00 less than asked, 9999 the provider is down.
 */
export const FAKE_SANDBOX_SUFFIXES = {
  approve: '1111',
  insufficientFunds: '2222',
  decline: '3333',
  noAnswer: '4444',
  shortPayment: '5555',
  outage: '9999',
} as const;

interface TransactionRow {
  id: string;
  merchant_id: string;
  reference: string;
  method: string;
  msisdn: string | null;
  amount_minor: bigint;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  failure_code: string | null;
  fee_minor: bigint;
  refunded_minor: bigint;
  return_url: string | null;
}

export interface FakeWebhookDelivery {
  accountId: string;
  body: Buffer;
  headers: Record<string, string>;
  returnUrl: string | null;
}

/**
 * DEVELOPMENT AND TESTS ONLY (Q-PAY-3; refused in production by configuration). A stand-in for a
 * payment aggregator: it keeps its own records in the `fake_provider` schema (the "provider's
 * database"), checks the merchant credentials on every call, signs its webhooks with the merchant's
 * secret and lets a person approve or decline on a simulated phone or a fake hosted card page.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly simulated = true;

  constructor(private readonly prisma: PrismaClient) {}

  parseCredentials(input: Record<string, unknown>): CredentialsResult {
    const parsed = fakeCredentialsSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((issue) => ({
          field: `credentials.${issue.path.join('.')}`,
          message: issue.message,
        })),
      };
    }
    const { webhookSecret, ...credentials } = parsed.data;
    return {
      ok: true,
      value: {
        credentials,
        webhookSecret,
        maskedHint: `Fake provider · merchant ••••${credentials.merchantId.slice(-4)} · ${credentials.profile}`,
      },
    };
  }

  async testConnection(
    account: ProviderAccount,
  ): Promise<{ ok: true; capabilities: PaymentCapabilities } | { ok: false; message: string }> {
    let credentials: FakeCredentials;
    try {
      credentials = this.authenticate(account);
    } catch {
      return { ok: false, message: 'The provider rejected these credentials.' };
    }
    await this.registerMerchant(credentials, account);
    return { ok: true, capabilities: FAKE_PROFILE_CAPABILITIES[credentials.profile] };
  }

  async startPayment(account: ProviderAccount, input: StartPaymentInput): Promise<StartPaymentResult> {
    const credentials = this.authenticate(account);
    const capabilities = FAKE_PROFILE_CAPABILITIES[credentials.profile];
    if (
      (input.method === 'CARD' && !capabilities.card) ||
      (input.method === 'MOBILE_MONEY' && capabilities.mobileMoney === null)
    ) {
      return {
        kind: 'FAILED',
        providerTransactionId: null,
        failureCode: 'PROVIDER_ERROR',
        message: 'Method not enabled',
      };
    }
    const suffix = input.msisdn?.slice(-4);
    if (suffix === FAKE_SANDBOX_SUFFIXES.outage)
      throw new ProviderUnavailableError('Simulated provider outage');
    await this.registerMerchant(credentials, account);

    const failed = suffix === FAKE_SANDBOX_SUFFIXES.insufficientFunds;
    const id = `fake_tx_${randomUUID()}`;
    await this.prisma.$executeRaw`
      INSERT INTO fake_provider.transaction
        (id, merchant_id, reference, method, msisdn, amount_minor, currency, status, failure_code, return_url)
      VALUES (${id}, ${credentials.merchantId}, ${input.reference}, ${input.method}, ${input.msisdn ?? null},
              ${input.amountMinor}, ${input.currency}, ${failed ? 'FAILED' : 'PENDING'},
              ${failed ? 'INSUFFICIENT_FUNDS' : null}, ${input.returnUrl})
      ON CONFLICT (merchant_id, reference) DO NOTHING`;
    const row = await this.byReference(credentials.merchantId, input.reference);
    if (row === null) throw new ProviderUnavailableError('Transaction not recorded');
    if (row.status === 'FAILED') {
      return {
        kind: 'FAILED',
        providerTransactionId: row.id,
        failureCode: row.failure_code ?? 'PROVIDER_ERROR',
        message: 'Insufficient balance',
      };
    }
    return {
      kind: 'PENDING',
      providerTransactionId: row.id,
      redirectUrl: input.method === 'CARD' ? `${FAKE_PAY_PATH}/${row.id}` : null,
    };
  }

  async getStatus(account: ProviderAccount, reference: string): Promise<ProviderStatus> {
    const credentials = this.authenticate(account);
    let row = await this.byReference(credentials.merchantId, reference);
    if (row === null) return { found: false };
    if (row.status === 'PENDING') {
      const scripted = this.scripted(row);
      if (scripted !== null) {
        await this.settle(row.id, scripted.status, scripted.failureCode, scripted.amountMinor);
        row = (await this.byReference(credentials.merchantId, reference)) ?? row;
      }
    }
    return {
      found: true,
      providerTransactionId: row.id,
      status: row.status,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      feeMinor: row.status === 'SUCCEEDED' ? Number(row.fee_minor) : null,
      failureCode: row.failure_code,
      refundedMinor: Number(row.refunded_minor),
    };
  }

  async refund(
    account: ProviderAccount,
    input: { reference: string; amountMinor: number; reason: string },
  ): Promise<RefundResult> {
    const credentials = this.authenticate(account);
    if (FAKE_PROFILE_CAPABILITIES[credentials.profile].refundApi === 'NONE') {
      return { ok: false, message: 'This account has no refund API.' };
    }
    const row = await this.byReference(credentials.merchantId, input.reference);
    if (row === null || row.status !== 'SUCCEEDED')
      return { ok: false, message: 'No settled payment to refund.' };
    if (Number(row.refunded_minor) + input.amountMinor > Number(row.amount_minor)) {
      return { ok: false, message: 'The refund exceeds the amount paid.' };
    }
    await this.prisma.$executeRaw`
      UPDATE fake_provider.transaction
         SET refunded_minor = refunded_minor + ${input.amountMinor}, updated_at = now()
       WHERE id = ${row.id}`;
    return { ok: true, providerRefundId: `fake_rf_${randomUUID()}` };
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    webhookSecret: string,
  ): ProviderEvent | null {
    const header = headers[FAKE_PAY_SIGNATURE_HEADER];
    const given = Buffer.from(typeof header === 'string' ? header : '', 'hex');
    const expected = Buffer.from(sign(rawBody, webhookSecret), 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (typeof body.eventId !== 'string' || typeof body.type !== 'string') return null;
    return {
      eventId: body.eventId.slice(0, 200),
      type: body.type.slice(0, 60),
      reference: typeof body.reference === 'string' ? body.reference : null,
      payload: body,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Development: the simulated phone, the hosted card page and test helpers
  // -------------------------------------------------------------------------------------------

  /** The transaction behind a hosted card page (amount and status only). */
  async transaction(id: string): Promise<{ amountMinor: number; currency: string; status: string } | null> {
    const rows = await this.prisma.$queryRaw<TransactionRow[]>`
      SELECT * FROM fake_provider.transaction WHERE id = ${id}`;
    const row = rows[0];
    return row === undefined
      ? null
      : { amountMinor: Number(row.amount_minor), currency: row.currency, status: row.status };
  }

  /**
   * The payer approves or declines (simulated phone or hosted card page). The provider then calls the
   * merchant's webhook with a signed event, as a real provider would. Returns that delivery.
   */
  async decide(transactionId: string, decision: 'APPROVE' | 'DECLINE'): Promise<FakeWebhookDelivery | null> {
    const rows = await this.prisma.$queryRaw<TransactionRow[]>`
      SELECT * FROM fake_provider.transaction WHERE id = ${transactionId}`;
    const row = rows[0];
    if (row === undefined) return null;
    if (row.status === 'PENDING') {
      const declined = row.method === 'CARD' ? 'CARD_DECLINED' : 'USER_DECLINED';
      await this.settle(
        row.id,
        decision === 'APPROVE' ? 'SUCCEEDED' : 'FAILED',
        decision === 'APPROVE' ? null : declined,
        Number(row.amount_minor),
      );
    }
    return this.webhookFor(row.id);
  }

  /** A signed "payment.updated" event for a transaction, addressed to its merchant's account. */
  async webhookFor(
    transactionId: string,
    eventId = `fake_ev_${randomUUID()}`,
  ): Promise<FakeWebhookDelivery | null> {
    const rows = await this.prisma.$queryRaw<
      (TransactionRow & { webhook_secret: string; callback_account_id: string })[]
    >`
      SELECT t.*, m.webhook_secret, m.callback_account_id
        FROM fake_provider.transaction t JOIN fake_provider.merchant m ON m.merchant_id = t.merchant_id
       WHERE t.id = ${transactionId}`;
    const row = rows[0];
    if (row === undefined) return null;
    const body = Buffer.from(
      JSON.stringify({
        eventId,
        type: 'payment.updated',
        reference: row.reference,
        transactionId: row.id,
        status: row.status,
      }),
    );
    return {
      accountId: row.callback_account_id,
      body,
      headers: { [FAKE_PAY_SIGNATURE_HEADER]: sign(body, row.webhook_secret) },
      returnUrl: row.return_url,
    };
  }

  // -------------------------------------------------------------------------------------------

  /** Checks the merchant credentials as the provider would; a bad key fails every call (AC 3). */
  private authenticate(account: ProviderAccount): FakeCredentials {
    const parsed = fakeCredentialsSchema.safeParse({
      ...account.credentials,
      webhookSecret: account.webhookSecret,
    });
    if (!parsed.success || parsed.data.apiKey.startsWith('bad')) {
      throw new ProviderUnavailableError('Authentication failed');
    }
    return parsed.data;
  }

  /** The merchant's webhook endpoint and secret, as configured at the provider. */
  private async registerMerchant(credentials: FakeCredentials, account: ProviderAccount): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO fake_provider.merchant (merchant_id, webhook_secret, callback_account_id)
      VALUES (${credentials.merchantId}, ${account.webhookSecret}, ${account.id}::uuid)
      ON CONFLICT (merchant_id) DO UPDATE
        SET webhook_secret = EXCLUDED.webhook_secret,
            callback_account_id = EXCLUDED.callback_account_id,
            updated_at = now()`;
  }

  private async byReference(merchantId: string, reference: string): Promise<TransactionRow | null> {
    const rows = await this.prisma.$queryRaw<TransactionRow[]>`
      SELECT * FROM fake_provider.transaction WHERE merchant_id = ${merchantId} AND reference = ${reference}`;
    return rows[0] ?? null;
  }

  private scripted(
    row: TransactionRow,
  ): { status: 'SUCCEEDED' | 'FAILED'; failureCode: string | null; amountMinor: number } | null {
    const amount = Number(row.amount_minor);
    switch (row.msisdn?.slice(-4)) {
      case FAKE_SANDBOX_SUFFIXES.approve:
        return { status: 'SUCCEEDED', failureCode: null, amountMinor: amount };
      case FAKE_SANDBOX_SUFFIXES.decline:
        return { status: 'FAILED', failureCode: 'USER_DECLINED', amountMinor: amount };
      case FAKE_SANDBOX_SUFFIXES.shortPayment:
        return { status: 'SUCCEEDED', failureCode: null, amountMinor: Math.max(1, amount - 100) };
      default:
        return null;
    }
  }

  private async settle(
    id: string,
    status: 'SUCCEEDED' | 'FAILED',
    failureCode: string | null,
    amountMinor: number,
  ): Promise<void> {
    const fee = status === 'SUCCEEDED' ? commissionOf(amountMinor, FEE_BPS) : 0;
    await this.prisma.$executeRaw`
      UPDATE fake_provider.transaction
         SET status = ${status}, failure_code = ${failureCode}, amount_minor = ${amountMinor},
             fee_minor = ${fee}, updated_at = now()
       WHERE id = ${id} AND status = 'PENDING'`;
  }
}

function sign(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}
