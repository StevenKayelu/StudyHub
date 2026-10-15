import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { createOrderSchema, startPaymentSchema } from '@studyhub/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { currentActor, type TenantActor } from '../../identity';
import { AppError, ConfigService, parseOrThrow, runWithContext, TenantDb } from '../../platform';
import { CheckoutService } from '../application/checkout.service';
import { PaymentWebhookService } from '../application/webhooks.service';
import { FakePaymentProvider } from '../infra/fake-payment-provider';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../infra/payment-gateway';

function requireActor(): TenantActor {
  const actor = currentActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

const uuid = () => new ParseUUIDPipe();
const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Learner checkout and purchases (05 §4.8, §5; F25, F27; S-L08–S-L11). */
@Controller('api/v1')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post('orders')
  async createOrder(
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_HEADER) key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = requireActor();
    const { courseId } = parseOrThrow(createOrderSchema, body);
    const outcome = await this.checkout.createOrder(actor, courseId, key);
    reply.status(outcome.status);
    return outcome.body;
  }

  @Get('orders/:id')
  @Header('Cache-Control', 'private, no-store')
  order(@Param('id', uuid()) id: string) {
    return this.checkout.order(requireActor(), id);
  }

  @Post('orders/:id/payments')
  async startPayment(
    @Param('id', uuid()) id: string,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_HEADER) key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = requireActor();
    const outcome = await this.checkout.startPayment(actor, id, parseOrThrow(startPaymentSchema, body), key);
    reply.status(outcome.status);
    return outcome.body;
  }

  /** Asks the provider about the order's latest payment (return page, "I didn't get a prompt"). */
  @Post('orders/:id/refresh')
  @HttpCode(200)
  refresh(@Param('id', uuid()) id: string) {
    return this.checkout.refresh(requireActor(), id);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id', uuid()) id: string) {
    return this.checkout.cancel(requireActor(), id);
  }

  @Get('me/orders')
  @Header('Cache-Control', 'private, no-store')
  myOrders() {
    return this.checkout.myOrders(requireActor());
  }

  @Get('me/orders/:id/receipt')
  @Header('Cache-Control', 'private, no-store')
  receipt(@Param('id', uuid()) id: string) {
    return this.checkout.receipt(requireActor(), id);
  }

  /** The provider's return URL (05 §4.8): only triggers a status check, then shows the order (F25 AC 1). */
  @Get('payments/return')
  async paymentReturn(@Query('ref') ref: string | undefined, @Res() reply: FastifyReply) {
    const actor = requireActor();
    const orderId =
      typeof ref === 'string' && /^[0-9a-f-]{36}$/i.test(ref)
        ? await this.checkout.returnFromProvider(actor, ref)
        : null;
    return reply.redirect(orderId === null ? '/account/purchases' : `/learn/orders/${orderId}`, 303);
  }
}

/**
 * Per-account payment webhooks (F26, F45; 05 §8.3). Not school-scoped by host: the account's school comes
 * from resolve_payment_account(), and the signature is checked with that account's own secret.
 */
@Controller('api/v1/webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post(':provider/:accountId')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Param('accountId') accountId: string,
    @Req() request: FastifyRequest & { rawBody?: Buffer },
  ) {
    await this.webhooks.handle(
      provider,
      accountId,
      request.rawBody ?? Buffer.alloc(0),
      request.headers as Record<string, string | string[] | undefined>,
    );
    return { received: true };
  }
}

/**
 * DEVELOPMENT ONLY: the fake provider's simulated phone and hosted card page (Q-PAY-3). Each decision makes
 * the fake send its signed webhook to the school's account, exactly as a real provider would. Refused in
 * production and whenever the fake adapter isn't configured.
 */
@Controller('api/v1/dev/fake-pay')
export class FakePaymentDevController {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly webhooks: PaymentWebhookService,
    private readonly db: TenantDb,
    private readonly config: ConfigService,
  ) {}

  private fake(): FakePaymentProvider {
    const fake = this.gateway.provider('fake');
    if (this.config.get('NODE_ENV') === 'production' || !(fake instanceof FakePaymentProvider)) {
      throw new AppError('NOT_FOUND');
    }
    return fake;
  }

  /** The simulated phone on the payment page: the payer approves or declines the prompt. */
  @Post('phone/:paymentId/:decision')
  @HttpCode(200)
  async phone(
    @Param('paymentId', uuid()) paymentId: string,
    @Param('decision') decision: string,
    @Req() request: FastifyRequest,
  ) {
    const fake = this.fake();
    const actor = requireActor();
    if (decision !== 'approve' && decision !== 'decline') throw new AppError('NOT_FOUND');
    const payment = await this.db.run((tx) =>
      tx.payment.findFirst({
        where: { id: paymentId, method: 'MOBILE_MONEY', order: { membershipId: actor.membershipId } },
        select: { providerTransactionId: true },
      }),
    );
    if (payment?.providerTransactionId === null || payment === null) throw new AppError('NOT_FOUND');
    await this.deliver(
      fake,
      payment.providerTransactionId,
      decision === 'approve' ? 'APPROVE' : 'DECLINE',
      request.id,
    );
    return { delivered: true };
  }

  /** The fake hosted card page (stands in for the provider's own page; no card data is ever entered). */
  @Get(':transactionId')
  @Header('Cache-Control', 'no-store')
  async cardPage(@Param('transactionId') transactionId: string, @Res() reply: FastifyReply) {
    const transaction = await this.fake().transaction(transactionId);
    if (transaction === null) throw new AppError('NOT_FOUND');
    const amount = `${transaction.currency === 'ZMW' ? 'K' : transaction.currency} ${(transaction.amountMinor / 100).toFixed(2)}`;
    const id = encodeURIComponent(transactionId);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fake card payment</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1c2126}
.note{background:#fff4d6;border:1px solid #e0b84f;padding:.75rem;border-radius:.5rem}button{font:inherit;padding:.6rem 1rem;margin-right:.5rem;border-radius:.4rem;border:1px solid #555;cursor:pointer}
.pay{background:#1c2126;color:#fff}</style></head><body>
<p class="note"><strong>Development only.</strong> This page stands in for the payment provider's hosted card page. No card details are collected.</p>
<h1>Pay ${amount}</h1><p>Status: ${transaction.status}</p>
<form method="post" action="/api/v1/dev/fake-pay/${id}/approve"><button class="pay" type="submit">Pay ${amount}</button></form>
<form method="post" action="/api/v1/dev/fake-pay/${id}/decline" style="margin-top:.75rem"><button type="submit">Decline</button></form>
</body></html>`;
    return reply.type('text/html; charset=utf-8').send(html);
  }

  @Post(':transactionId/:decision')
  async cardDecision(
    @Param('transactionId') transactionId: string,
    @Param('decision') decision: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const fake = this.fake();
    if (decision !== 'approve' && decision !== 'decline') throw new AppError('NOT_FOUND');
    const returnUrl = await this.deliver(
      fake,
      transactionId,
      decision === 'approve' ? 'APPROVE' : 'DECLINE',
      request.id,
    );
    return reply.redirect(returnUrl ?? '/', 303);
  }

  private async deliver(
    fake: FakePaymentProvider,
    transactionId: string,
    decision: 'APPROVE' | 'DECLINE',
    requestId: string,
  ): Promise<string | null> {
    const delivery = await fake.decide(transactionId, decision);
    if (delivery === null) throw new AppError('NOT_FOUND');
    // The provider's callback carries no school context of its own.
    await runWithContext({ requestId }, () =>
      this.webhooks.handle('fake', delivery.accountId, delivery.body, delivery.headers),
    );
    return delivery.returnUrl;
  }
}
