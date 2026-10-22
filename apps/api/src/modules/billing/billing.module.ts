import { Module } from '@nestjs/common';

import { BillingConsoleController } from './api/billing.controller';
import { BillingCatalogueService } from './application/catalogue.service';
import { InvoicingService } from './application/invoicing.service';
import { SubscriptionsService } from './application/subscriptions';

/** SaaS billing (docs/design/saas-billing.md): plans, contracts, invoices and the platform ledger. */
@Module({
  controllers: [BillingConsoleController],
  providers: [BillingCatalogueService, InvoicingService, SubscriptionsService],
  exports: [BillingCatalogueService, InvoicingService, SubscriptionsService],
})
export class BillingModule {}
