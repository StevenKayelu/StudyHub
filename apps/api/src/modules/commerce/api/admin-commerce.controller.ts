import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  adminOrdersQuerySchema,
  createPaymentAccountSchema,
  payoutMethodInputSchema,
  recordPayoutSchema,
  refundRequestSchema,
  replaceCredentialsSchema,
  resolveExceptionSchema,
  settingsPatchSchema,
} from '@studyhub/contracts';
import type { RefundRequest } from '@studyhub/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { currentActor, type TenantActor } from '../../identity';
import { AppError, parseOrThrow } from '../../platform';
import { AdminOrdersService } from '../application/admin-orders.service';
import { CommerceSettingsService } from '../application/commerce-settings.service';
import { EarningsService } from '../application/earnings.service';
import { PaymentAccountsService } from '../application/payment-accounts.service';

function requireActor(): TenantActor {
  const actor = currentActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

const uuid = () => new ParseUUIDPipe();
const adminRefundSchema = z.intersection(refundRequestSchema, z.object({ paymentId: z.uuid().optional() }));

/** School administration of payments (05 §4.9, §8.3; F26, F28, F29, F45; S-AD02–S-AD05, S-AD09, S-AD15). */
@Controller('api/v1/admin')
export class AdminCommerceController {
  constructor(
    private readonly accounts: PaymentAccountsService,
    private readonly settings: CommerceSettingsService,
    private readonly orders: AdminOrdersService,
    private readonly earnings: EarningsService,
  ) {}

  // --- Settings (payments group) -----------------------------------------------------------------

  @Get('settings')
  @Header('Cache-Control', 'private, no-store')
  getSettings() {
    return this.settings.get(requireActor());
  }

  @Patch('settings')
  patchSettings(@Body() body: unknown) {
    const actor = requireActor();
    return this.settings.patch(actor, parseOrThrow(settingsPatchSchema, body));
  }

  // --- Payment accounts (owner) -------------------------------------------------------------------

  @Get('payment-providers')
  @Header('Cache-Control', 'private, no-store')
  providers() {
    return this.accounts.providers(requireActor());
  }

  @Get('payment-accounts')
  @Header('Cache-Control', 'private, no-store')
  listAccounts() {
    return this.accounts.list(requireActor());
  }

  @Post('payment-accounts')
  @HttpCode(201)
  createAccount(@Body() body: unknown) {
    const actor = requireActor();
    return this.accounts.create(actor, parseOrThrow(createPaymentAccountSchema, body));
  }

  @Put('payment-accounts/:id/credentials')
  replaceCredentials(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.accounts.replaceCredentials(
      actor,
      id,
      parseOrThrow(replaceCredentialsSchema, body).credentials,
    );
  }

  @Post('payment-accounts/:id/test')
  @HttpCode(200)
  testAccount(@Param('id', uuid()) id: string) {
    return this.accounts.test(requireActor(), id);
  }

  @Post('payment-accounts/:id/activate')
  @HttpCode(200)
  activateAccount(@Param('id', uuid()) id: string) {
    return this.accounts.activate(requireActor(), id);
  }

  @Delete('payment-accounts/:id')
  disableAccount(@Param('id', uuid()) id: string) {
    return this.accounts.disable(requireActor(), id);
  }

  @Get('payment-accounts/:id/capabilities')
  @Header('Cache-Control', 'private, no-store')
  capabilities(@Param('id', uuid()) id: string) {
    return this.accounts.capabilities(requireActor(), id);
  }

  // --- Orders, exceptions, refunds ----------------------------------------------------------------

  @Get('orders')
  @Header('Cache-Control', 'private, no-store')
  listOrders(@Query() query: Record<string, unknown>) {
    const actor = requireActor();
    return this.orders.list(actor, parseOrThrow(adminOrdersQuerySchema, query));
  }

  @Get('orders/:id')
  @Header('Cache-Control', 'private, no-store')
  orderDetail(@Param('id', uuid()) id: string) {
    return this.orders.detail(requireActor(), id);
  }

  @Post('orders/:id/refunds')
  async refund(
    @Param('id', uuid()) id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const actor = requireActor();
    const { paymentId, ...request } = parseOrThrow(adminRefundSchema, body);
    const outcome = await this.orders.refund(actor, id, request as RefundRequest, paymentId, key);
    reply.status(outcome.status);
    return outcome.body;
  }

  @Get('payment-exceptions')
  @Header('Cache-Control', 'private, no-store')
  exceptions() {
    return this.orders.exceptions(requireActor());
  }

  @Post('payments/:id/recheck')
  @HttpCode(200)
  recheck(@Param('id', uuid()) id: string) {
    return this.orders.recheck(requireActor(), id);
  }

  @Post('payments/:id/resolve')
  @HttpCode(200)
  resolve(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.orders.accept(actor, id, parseOrThrow(resolveExceptionSchema, body).note);
  }

  // --- Earnings and payouts (revenue share) -------------------------------------------------------

  @Get('earnings')
  @Header('Cache-Control', 'private, no-store')
  instructors() {
    return this.earnings.instructors(requireActor());
  }

  @Get('earnings/:membershipId')
  @Header('Cache-Control', 'private, no-store')
  instructorLedger(@Param('membershipId', uuid()) membershipId: string) {
    return this.earnings.instructorLedger(requireActor(), membershipId);
  }

  @Post('payouts')
  @HttpCode(201)
  recordPayout(@Body() body: unknown) {
    const actor = requireActor();
    return this.earnings.recordPayout(actor, parseOrThrow(recordPayoutSchema, body));
  }

  @Get('payouts')
  @Header('Cache-Control', 'private, no-store')
  payouts() {
    return this.earnings.payouts(requireActor());
  }
}

/** The instructor's own earnings and payout methods (S-T11, S-T12). */
@Controller('api/v1')
export class InstructorEarningsController {
  constructor(private readonly earnings: EarningsService) {}

  @Get('studio/earnings')
  @Header('Cache-Control', 'private, no-store')
  mine() {
    return this.earnings.mine(requireActor());
  }

  @Get('studio/earnings.csv')
  @Header('Cache-Control', 'private, no-store')
  async mineCsv(@Res() reply: FastifyReply) {
    const csv = await this.earnings.mineCsv(requireActor());
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="earnings.csv"')
      .send(csv);
  }

  @Get('me/payout-methods')
  @Header('Cache-Control', 'private, no-store')
  payoutMethods() {
    return this.earnings.payoutMethods(requireActor());
  }

  @Post('me/payout-methods')
  @HttpCode(201)
  addPayoutMethod(@Body() body: unknown) {
    const actor = requireActor();
    return this.earnings.addPayoutMethod(actor, parseOrThrow(payoutMethodInputSchema, body));
  }

  @Post('me/payout-methods/:id/default')
  @HttpCode(200)
  makeDefault(@Param('id', uuid()) id: string) {
    return this.earnings.makeDefault(requireActor(), id);
  }

  @Delete('me/payout-methods/:id')
  removePayoutMethod(@Param('id', uuid()) id: string) {
    return this.earnings.removePayoutMethod(requireActor(), id);
  }
}
