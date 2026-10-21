import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  commercialPlanInputSchema,
  contractInputSchema,
  invoiceDraftInputSchema,
  invoiceVoidSchema,
  planVersionInputSchema,
  pricingPreviewInputSchema,
} from '@studyhub/contracts';
import { z } from 'zod';

import { requireRecentReauth, requireRole, requireStaff } from '../../console';
import { parseOrThrow } from '../../platform';
import { BillingCatalogueService } from '../application/catalogue.service';
import { InvoicingService } from '../application/invoicing.service';

const uuid = () => new ParseUUIDPipe();
const NO_STORE = 'private, no-store';

/** Platform staff who handle billing: owners and operators. */
function finance() {
  const actor = requireStaff();
  requireRole(actor, 'PLATFORM_OWNER', 'PLATFORM_OPERATOR');
  return actor;
}

/** Money-changing actions need a fresh TOTP re-authentication; prices and terms are owners' only. */
function sensitive(...roles: ('PLATFORM_OWNER' | 'PLATFORM_OPERATOR')[]) {
  const actor = requireStaff();
  requireRole(actor, ...roles);
  requireRecentReauth(actor);
  return actor;
}

/** SaaS billing in the console (docs/design/saas-billing.md, phase 2). Every change is audited. */
@Controller('console/billing')
export class BillingConsoleController {
  constructor(
    private readonly catalogue: BillingCatalogueService,
    private readonly invoicing: InvoicingService,
  ) {}

  // --- Commercial plans ------------------------------------------------------------------------------

  @Get('plans')
  @Header('Cache-Control', NO_STORE)
  plans() {
    finance();
    return this.catalogue.plans();
  }

  @Post('plans')
  @HttpCode(201)
  createPlan(@Body() body: unknown) {
    return this.catalogue.createPlan(
      sensitive('PLATFORM_OWNER'),
      parseOrThrow(commercialPlanInputSchema, body),
    );
  }

  @Post('plans/:id/versions')
  @HttpCode(201)
  createVersion(@Param('id', uuid()) id: string, @Body() body: unknown) {
    return this.catalogue.createVersion(
      sensitive('PLATFORM_OWNER'),
      id,
      parseOrThrow(planVersionInputSchema, body),
    );
  }

  @Patch('versions/:id')
  updateVersion(@Param('id', uuid()) id: string, @Body() body: unknown) {
    return this.catalogue.updateDraft(
      sensitive('PLATFORM_OWNER'),
      id,
      parseOrThrow(planVersionInputSchema, body),
    );
  }

  @Post('versions/:id/publish')
  @HttpCode(200)
  publish(@Param('id', uuid()) id: string) {
    return this.catalogue.setVersionStatus(sensitive('PLATFORM_OWNER'), id, 'PUBLISHED');
  }

  @Post('versions/:id/archive')
  @HttpCode(200)
  archive(@Param('id', uuid()) id: string) {
    return this.catalogue.setVersionStatus(sensitive('PLATFORM_OWNER'), id, 'ARCHIVED');
  }

  /** The invoice a version would produce for sample figures (before publishing it). */
  @Post('versions/:id/preview')
  @HttpCode(200)
  preview(@Param('id', uuid()) id: string, @Body() body: unknown) {
    finance();
    return this.invoicing.preview(id, parseOrThrow(pricingPreviewInputSchema, body));
  }

  // --- Contracts ---------------------------------------------------------------------------------------

  @Get('tenants/:tenantId/contracts')
  @Header('Cache-Control', NO_STORE)
  contracts(@Param('tenantId', uuid()) tenantId: string) {
    finance();
    return this.catalogue.contracts(tenantId);
  }

  @Post('tenants/:tenantId/contracts')
  @HttpCode(201)
  createContract(@Param('tenantId', uuid()) tenantId: string, @Body() body: unknown) {
    return this.catalogue.createContract(
      sensitive('PLATFORM_OWNER', 'PLATFORM_OPERATOR'),
      tenantId,
      parseOrThrow(contractInputSchema, body),
    );
  }

  @Post('contracts/:id/activate')
  @HttpCode(204)
  async activate(@Param('id', uuid()) id: string): Promise<void> {
    await this.catalogue.activateContract(sensitive('PLATFORM_OWNER', 'PLATFORM_OPERATOR'), id);
  }

  // --- Invoices and ledger ---------------------------------------------------------------------------

  @Get('tenants/:tenantId/invoices')
  @Header('Cache-Control', NO_STORE)
  invoices(@Param('tenantId', uuid()) tenantId: string) {
    finance();
    return this.invoicing.list(tenantId);
  }

  @Post('tenants/:tenantId/invoices')
  @HttpCode(201)
  draft(@Param('tenantId', uuid()) tenantId: string, @Body() body: unknown) {
    const { forDate } = parseOrThrow(invoiceDraftInputSchema, body);
    return this.invoicing.draft(finance(), tenantId, forDate);
  }

  @Get('invoices/:id')
  @Header('Cache-Control', NO_STORE)
  invoice(@Param('id', uuid()) id: string) {
    finance();
    return this.invoicing.get(id);
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  issue(@Param('id', uuid()) id: string) {
    return this.invoicing.issue(sensitive('PLATFORM_OWNER', 'PLATFORM_OPERATOR'), id);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  void(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const { reason } = parseOrThrow(invoiceVoidSchema, body);
    return this.invoicing.void(sensitive('PLATFORM_OWNER', 'PLATFORM_OPERATOR'), id, reason);
  }

  @Get('ledger/trial-balance')
  @Header('Cache-Control', NO_STORE)
  trialBalance(@Query('tenantId') tenantId: unknown) {
    finance();
    return this.invoicing.trialBalance(parseOrThrow(z.uuid().optional(), tenantId));
  }
}
