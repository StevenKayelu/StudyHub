import type { PrismaClient } from '../../../generated/prisma/client';
import { type ApiEnv, AppError } from '../../platform';
import { CircuitBreakers } from '../domain/circuit-breaker';
import { FakePaymentProvider } from './fake-payment-provider';
import { type PaymentProvider, type ProviderAccount, ProviderUnavailableError } from './payment-provider';
import { PaymentVault } from './payment-vault';

/** Nest injection token. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/**
 * The adapters this deployment may use (PAYMENT_PROVIDERS), the vault for school credentials and the
 * per-account circuit breakers. Every provider call goes through `call`, keyed by the account.
 */
export class PaymentGateway {
  private readonly providers: ReadonlyMap<string, PaymentProvider>;

  constructor(
    providers: readonly PaymentProvider[],
    readonly vault: PaymentVault,
    private readonly breakers = new CircuitBreakers(),
  ) {
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  /** Names schools may connect. */
  names(): string[] {
    return [...this.providers.keys()];
  }

  provider(name: string): PaymentProvider | null {
    return this.providers.get(name) ?? null;
  }

  requireProvider(name: string): PaymentProvider {
    const provider = this.provider(name);
    if (provider === null) throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE');
    return provider;
  }

  /** The account's decrypted credentials, for one provider call (never stored or returned). */
  open(
    tenantId: string,
    account: { id: string; credentialsEnc: Uint8Array; webhookSecretEnc: Uint8Array; dataKeyEnc: Uint8Array },
  ): ProviderAccount {
    const opened = this.vault.openAccount(tenantId, account);
    return { id: account.id, ...opened };
  }

  /**
   * Runs one provider call for an account. While its breaker is open, or when the provider can't be
   * reached or refuses the credentials, the caller gets 503 PAYMENT_PROVIDER_UNAVAILABLE.
   */
  async call<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    if (this.breakers.isOpen(accountId)) throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE');
    try {
      const result = await fn();
      this.breakers.recordSuccess(accountId);
      return result;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        this.breakers.recordFailure(accountId);
        throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE');
      }
      throw error;
    }
  }
}

export function createPaymentGateway(
  env: Pick<ApiEnv, 'NODE_ENV' | 'PAYMENT_PROVIDERS' | 'PAYMENT_ENCRYPTION_KEY'>,
  prisma: PrismaClient,
): PaymentGateway {
  const providers: PaymentProvider[] = [];
  if (env.PAYMENT_PROVIDERS.includes('fake') && env.NODE_ENV !== 'production') {
    providers.push(new FakePaymentProvider(prisma));
  }
  return new PaymentGateway(providers, new PaymentVault(env.PAYMENT_ENCRYPTION_KEY));
}
