import type { MobileNetwork, PaymentCapabilities, PaymentMethod } from '@studyhub/contracts';

/**
 * Payment provider port (04 §17.10, ADR-019). Adapters are used PER SCHOOL ACCOUNT, never globally: every
 * call carries that account's own decrypted credentials. Provider-specific data stays inside the adapter
 * and in `payment.provider_transaction_id` / `payment_event.payload` (05 §8.2: switching providers needs a
 * new adapter only). Until a provider is approved (Q-PAY-3) only the fake adapter exists.
 */

export interface ProviderAccount {
  id: string;
  credentials: Record<string, unknown>;
  webhookSecret: string;
}

export interface ParsedCredentials {
  credentials: Record<string, unknown>;
  webhookSecret: string;
  /** Safe to show: e.g. "fake · merchant ••••1234". */
  maskedHint: string;
}

export type CredentialsResult =
  { ok: true; value: ParsedCredentials } | { ok: false; errors: { field: string; message: string }[] };

export interface StartPaymentInput {
  /** Our payment reference (UUID), sent to the provider and echoed in its events. */
  reference: string;
  amountMinor: number;
  currency: string;
  method: PaymentMethod;
  msisdn?: string;
  network?: MobileNetwork;
  /** Card: where the provider's hosted page sends the learner back (only triggers a status check). */
  returnUrl: string;
  description: string;
}

export type StartPaymentResult =
  | { kind: 'PENDING'; providerTransactionId: string; redirectUrl: string | null }
  | { kind: 'FAILED'; providerTransactionId: string | null; failureCode: string; message: string };

/** The provider's authoritative view of one payment (F26: always re-queried before acting). */
export type ProviderStatus =
  | { found: false }
  | {
      found: true;
      providerTransactionId: string;
      status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
      amountMinor: number;
      currency: string;
      feeMinor: number | null;
      failureCode: string | null;
      refundedMinor: number;
    };

/** One settled transaction from the provider's list or statement (W7). */
export interface ProviderTransaction {
  reference: string;
  amountMinor: number;
  currency: string;
  status: 'SUCCEEDED' | 'REFUNDED';
  settledAt: Date;
}

export type RefundResult = { ok: true; providerRefundId: string } | { ok: false; message: string };

/** A verified webhook event: only what routing needs. Its claims are re-checked with getStatus. */
export interface ProviderEvent {
  eventId: string;
  type: string;
  reference: string | null;
  payload: Record<string, unknown>;
}

/** The provider could not be reached or refused our credentials: counted by the circuit breaker. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export interface PaymentProvider {
  readonly name: string;
  /** Validates what an owner typed into the connect form (write-only afterwards, F45 AC 3). */
  parseCredentials(input: Record<string, unknown>): CredentialsResult;
  /** F45 connection test: a sandbox call that also detects the account's capabilities (BR-62). */
  testConnection(
    account: ProviderAccount,
  ): Promise<{ ok: true; capabilities: PaymentCapabilities } | { ok: false; message: string }>;
  startPayment(account: ProviderAccount, input: StartPaymentInput): Promise<StartPaymentResult>;
  getStatus(account: ProviderAccount, reference: string): Promise<ProviderStatus>;
  refund(
    account: ProviderAccount,
    input: { reference: string; amountMinor: number; reason: string },
  ): Promise<RefundResult>;
  /** Verifies the signature over the RAW body with this account's secret (constant time); null if invalid. */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    webhookSecret: string,
  ): ProviderEvent | null;
  /**
   * W7: settled transactions in a period, only for accounts whose capabilities include
   * transactionListApi. Otherwise the school uploads the provider's CSV statement.
   */
  listTransactions?(
    account: ProviderAccount,
    range: { start: Date; end: Date },
  ): Promise<ProviderTransaction[]>;
  /** Development only: true when the payer approves on a simulated phone (the fake adapter). */
  readonly simulated: boolean;
}
