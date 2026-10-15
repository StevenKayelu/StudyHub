import { Module } from '@nestjs/common';

import { AuditModule } from '../audit';
import { ConfigService, PrismaService } from '../platform';
import { AdminCommerceController, InstructorEarningsController } from './api/admin-commerce.controller';
import {
  CheckoutController,
  FakePaymentDevController,
  PaymentWebhookController,
} from './api/commerce.controller';
import { AdminOrdersService } from './application/admin-orders.service';
import { CheckoutService } from './application/checkout.service';
import { CommerceSettingsService } from './application/commerce-settings.service';
import { EarningsService } from './application/earnings.service';
import { PaymentAccountsService } from './application/payment-accounts.service';
import { PaymentWebhookService } from './application/webhooks.service';
import { createPaymentGateway, PAYMENT_GATEWAY } from './infra/payment-gateway';

/** Commerce (M8): payment accounts, checkout, webhooks, refunds, receipts, earnings ledger and payouts. */
@Module({
  imports: [AuditModule],
  controllers: [
    CheckoutController,
    PaymentWebhookController,
    FakePaymentDevController,
    AdminCommerceController,
    InstructorEarningsController,
  ],
  providers: [
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        createPaymentGateway(
          {
            NODE_ENV: config.get('NODE_ENV'),
            PAYMENT_PROVIDERS: config.get('PAYMENT_PROVIDERS'),
            PAYMENT_ENCRYPTION_KEY: config.get('PAYMENT_ENCRYPTION_KEY'),
          },
          prisma,
        ),
    },
    CheckoutService,
    PaymentWebhookService,
    PaymentAccountsService,
    CommerceSettingsService,
    AdminOrdersService,
    EarningsService,
  ],
})
export class CommerceModule {}
