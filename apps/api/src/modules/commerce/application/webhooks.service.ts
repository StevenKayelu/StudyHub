import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import {
  addToOutbox,
  APP_LOGGER,
  AppError,
  currentContext,
  PrismaService,
  runInTenantTx,
  runWithContext,
} from '../../platform';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../infra/payment-gateway';
import { PAYMENT_EVENT_JOB } from './settlement';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-account payment webhooks (F26, F45 AC 2; 04 §17.10; 05 §5 pseudo-contract):
 * 1. resolve_payment_account(id) (definer) gives only the account's school and provider;
 * 2. inside THAT school's context, the account's own secret verifies the signature over the raw body
 *    (401 and a log line when it fails);
 * 3. the event is stored once (unique per account and provider event id) with an outbox row, and the
 *    request is answered at once. The worker re-queries the provider before acting.
 * An event can only ever name payments of its own account: a reference from another account or school is
 * simply not found under RLS, so a secret can never affect another school's orders (07 M8 AC 2).
 */
@Injectable()
export class PaymentWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {}

  async handle(
    providerName: string,
    accountId: string,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ stored: boolean }> {
    const provider = this.gateway.provider(providerName);
    if (!UUID.test(accountId) || provider === null) throw new AppError('NOT_FOUND');
    const rows = await this.prisma.$queryRaw<{ tenant_id: string; provider: string }[]>`
      SELECT tenant_id, provider FROM resolve_payment_account(${accountId}::uuid)`;
    const target = rows[0];
    if (target === undefined || target.provider !== providerName) {
      this.logger.warn({ provider: providerName }, 'Payment webhook for an unknown account');
      throw new AppError('NOT_FOUND');
    }

    return runWithContext(
      { requestId: currentContext()?.requestId ?? `webhook_${accountId}`, tenantId: target.tenant_id },
      async () => {
        const account = await runInTenantTx(this.prisma, (tx) =>
          tx.paymentAccount.findUniqueOrThrow({
            where: { id: accountId },
            select: { id: true, credentialsEnc: true, webhookSecretEnc: true, dataKeyEnc: true },
          }),
        );
        const { webhookSecret } = this.gateway.open(target.tenant_id, account);
        const event = provider.verifyWebhook(rawBody, headers, webhookSecret);
        if (event === null) {
          this.logger.warn(
            { provider: providerName, accountId, tenantId: target.tenant_id },
            'Payment webhook with an invalid signature rejected',
          );
          throw new AppError('UNAUTHENTICATED', { detail: 'Invalid signature.' });
        }

        return runInTenantTx(this.prisma, async (tx) => {
          const payment =
            event.reference !== null && UUID.test(event.reference)
              ? await tx.payment.findFirst({
                  where: { reference: event.reference, paymentAccountId: accountId },
                  select: { id: true },
                })
              : null;
          const inserted = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO payment_event (tenant_id, payment_account_id, provider_event_id, payment_id, type, payload)
            VALUES (${target.tenant_id}::uuid, ${accountId}::uuid, ${event.eventId}, ${payment?.id ?? null}::uuid,
                    ${event.type}, ${JSON.stringify(event.payload)}::jsonb)
            ON CONFLICT (tenant_id, payment_account_id, provider_event_id) DO NOTHING
            RETURNING id`;
          const stored = inserted[0];
          if (stored === undefined) return { stored: false }; // a replay (F26 AC 1)
          await addToOutbox(tx, PAYMENT_EVENT_JOB, { eventId: stored.id });
          return { stored: true };
        });
      },
    );
  }
}
