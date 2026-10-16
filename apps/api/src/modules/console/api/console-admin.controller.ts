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
  Put,
  Query,
} from '@nestjs/common';
import {
  consoleAuditQuerySchema,
  consoleSettingsPatchSchema,
  consoleTenantQuerySchema,
  createStaffRequestSchema,
  createTenantRequestSchema,
  domainDecisionRequestSchema,
  featureKeySchema,
  featureOverrideRequestSchema,
  generateStatementsRequestSchema,
  lifecycleRequestSchema,
  markPaidRequestSchema,
  ownerInvitationRequestSchema,
  periodSchema,
  planInputSchema,
  planPatchSchema,
  staffRoleRequestSchema,
  supportRequestSchema,
  tenantPatchSchema,
} from '@studyhub/contracts';
import { z } from 'zod';

import { parseOrThrow } from '../../platform';
import { ConsoleBillingService } from '../application/console-billing.service';
import { ConsolePlatformService } from '../application/console-platform.service';
import { ConsoleSupportService } from '../application/console-support.service';
import { ConsoleTenantsService, type LifecycleAction } from '../application/console-tenants.service';
import { requireRecentReauth, requireRole, requireStaff } from './console-guards';

const uuid = () => new ParseUUIDPipe();
const NO_STORE = 'private, no-store';
const LIFECYCLE_ACTIONS = ['activate', 'suspend', 'unsuspend', 'offboard', 'cancel-offboarding'] as const;

/** Staff who manage schools (05 §8.4): owners and operators; support staff read only. */
function manager() {
  const actor = requireStaff();
  requireRole(actor, 'PLATFORM_OWNER', 'PLATFORM_OPERATOR');
  return actor;
}

/** Sensitive console actions need a fresh TOTP re-authentication (04 §17.5). */
function sensitive(...roles: ('PLATFORM_OWNER' | 'PLATFORM_OPERATOR' | 'PLATFORM_SUPPORT')[]) {
  const actor = requireStaff();
  requireRole(actor, ...roles);
  requireRecentReauth(actor);
  return actor;
}

/** Platform console (F43, 05 §8.4). Every mutation writes the platform audit log. */
@Controller('console')
export class ConsoleAdminController {
  constructor(
    private readonly tenants: ConsoleTenantsService,
    private readonly platform: ConsolePlatformService,
    private readonly billing: ConsoleBillingService,
    private readonly support: ConsoleSupportService,
  ) {}

  // --- Overview (S-C02) -----------------------------------------------------------------------------

  @Get('overview')
  @Header('Cache-Control', NO_STORE)
  overview() {
    requireStaff();
    return this.platform.overview();
  }

  @Get('metrics')
  @Header('Cache-Control', NO_STORE)
  metrics() {
    manager();
    return this.platform.metrics();
  }

  @Get('providers/health')
  @Header('Cache-Control', NO_STORE)
  health() {
    manager();
    return this.platform.health();
  }

  @Get('payment-providers')
  @Header('Cache-Control', NO_STORE)
  paymentProviders() {
    manager();
    return this.platform.paymentProviders();
  }

  // --- Schools (S-C03–S-C05) -------------------------------------------------------------------------

  @Get('tenants')
  @Header('Cache-Control', NO_STORE)
  tenantList(@Query() query: unknown) {
    requireStaff();
    return this.tenants.list(parseOrThrow(consoleTenantQuerySchema, query));
  }

  @Get('tenants/slug-availability')
  @Header('Cache-Control', NO_STORE)
  slugAvailability(@Query('slug') slug: unknown) {
    manager();
    return this.tenants.slugAvailability(parseOrThrow(z.string().min(1).max(63), slug));
  }

  @Post('tenants')
  @HttpCode(201)
  createTenant(@Body() body: unknown) {
    return this.tenants.create(manager(), parseOrThrow(createTenantRequestSchema, body));
  }

  @Get('tenants/:id')
  @Header('Cache-Control', NO_STORE)
  tenant(@Param('id', uuid()) id: string) {
    requireStaff();
    return this.tenants.detail(id);
  }

  @Patch('tenants/:id')
  @HttpCode(204)
  async patchTenant(@Param('id', uuid()) id: string, @Body() body: unknown): Promise<void> {
    await this.tenants.patch(
      sensitive('PLATFORM_OWNER', 'PLATFORM_OPERATOR'),
      id,
      parseOrThrow(tenantPatchSchema, body),
    );
  }

  @Post('tenants/:id/:action')
  @HttpCode(200)
  lifecycle(@Param('id', uuid()) id: string, @Param('action') action: string, @Body() body: unknown) {
    const parsed = parseOrThrow(z.enum(LIFECYCLE_ACTIONS), action) as LifecycleAction;
    const { reason } = parseOrThrow(lifecycleRequestSchema, body);
    return this.tenants.lifecycle(sensitive('PLATFORM_OWNER', 'PLATFORM_OPERATOR'), id, parsed, reason);
  }

  @Put('tenants/:id/features/:key')
  @HttpCode(204)
  async override(
    @Param('id', uuid()) id: string,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<void> {
    const feature = parseOrThrow(featureKeySchema, key);
    const input = parseOrThrow(featureOverrideRequestSchema, body);
    await this.tenants.setOverride(
      sensitive('PLATFORM_OWNER', 'PLATFORM_OPERATOR'),
      id,
      feature,
      input.override,
      input.reason,
    );
  }

  @Post('tenants/:id/owner-invitation')
  @HttpCode(200)
  ownerInvitation(@Param('id', uuid()) id: string, @Body() body: unknown) {
    return this.tenants.resendOwnerInvitation(
      manager(),
      id,
      parseOrThrow(ownerInvitationRequestSchema, body ?? {}).email,
    );
  }

  // --- Plans (S-C06) ----------------------------------------------------------------------------------

  @Get('plans')
  @Header('Cache-Control', NO_STORE)
  plans() {
    manager();
    return this.platform.plans();
  }

  @Post('plans')
  @HttpCode(201)
  createPlan(@Body() body: unknown) {
    return this.platform.createPlan(sensitive('PLATFORM_OWNER'), parseOrThrow(planInputSchema, body));
  }

  @Patch('plans/:id')
  @HttpCode(200)
  updatePlan(@Param('id', uuid()) id: string, @Body() body: unknown) {
    return this.platform.updatePlan(sensitive('PLATFORM_OWNER'), id, parseOrThrow(planPatchSchema, body));
  }

  // --- Staff (S-C07) ----------------------------------------------------------------------------------

  @Post('staff')
  @HttpCode(201)
  createStaff(@Body() body: unknown) {
    return this.platform.createStaff(
      sensitive('PLATFORM_OWNER'),
      parseOrThrow(createStaffRequestSchema, body),
    );
  }

  @Patch('staff/:id')
  @HttpCode(204)
  async staffRole(@Param('id', uuid()) id: string, @Body() body: unknown): Promise<void> {
    await this.platform.changeStaffRole(
      sensitive('PLATFORM_OWNER'),
      id,
      parseOrThrow(staffRoleRequestSchema, body).role,
    );
  }

  // --- Global settings and audit (S-C08, S-C09) ---------------------------------------------------------

  @Get('settings')
  @Header('Cache-Control', NO_STORE)
  settings() {
    const actor = requireStaff();
    requireRole(actor, 'PLATFORM_OWNER');
    return this.platform.settings();
  }

  @Put('settings')
  @HttpCode(200)
  updateSettings(@Body() body: unknown) {
    return this.platform.updateSettings(
      sensitive('PLATFORM_OWNER'),
      parseOrThrow(consoleSettingsPatchSchema, body),
    );
  }

  /** F49: the platform audit log is the platform owner's (operators see their schools' entries via detail). */
  @Get('audit-log')
  @Header('Cache-Control', NO_STORE)
  audit(@Query() query: unknown) {
    const actor = requireStaff();
    requireRole(actor, 'PLATFORM_OWNER');
    return this.platform.audit(parseOrThrow(consoleAuditQuerySchema, query));
  }

  // --- Domain change requests ---------------------------------------------------------------------------

  @Get('domain-change-requests')
  @Header('Cache-Control', NO_STORE)
  domainRequests(@Query('status') status: unknown) {
    manager();
    return this.billing.domainRequests(
      parseOrThrow(z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(), status),
    );
  }

  @Post('domain-change-requests/:id/decision')
  @HttpCode(204)
  async decideDomain(@Param('id', uuid()) id: string, @Body() body: unknown): Promise<void> {
    const input = parseOrThrow(domainDecisionRequestSchema, body);
    await this.billing.decideDomain(manager(), id, input.decision === 'APPROVE', input.note);
  }

  // --- Statements (W8) ------------------------------------------------------------------------------------

  @Get('statements')
  @Header('Cache-Control', NO_STORE)
  statements(@Query('period') period: unknown) {
    manager();
    return this.billing.statements(parseOrThrow(periodSchema.optional(), period));
  }

  @Post('statements/generate')
  @HttpCode(200)
  generate(@Body() body: unknown) {
    return this.billing.generate(manager(), parseOrThrow(generateStatementsRequestSchema, body).period);
  }

  @Post('statements/:id/issue')
  @HttpCode(204)
  async issue(@Param('id', uuid()) id: string): Promise<void> {
    await this.billing.transition(manager(), id, 'issue', {});
  }

  @Post('statements/:id/mark-paid')
  @HttpCode(204)
  async markPaid(@Param('id', uuid()) id: string, @Body() body: unknown): Promise<void> {
    await this.billing.transition(manager(), id, 'mark-paid', parseOrThrow(markPaidRequestSchema, body));
  }

  @Post('statements/:id/void')
  @HttpCode(204)
  async voidStatement(@Param('id', uuid()) id: string, @Body() body: unknown): Promise<void> {
    await this.billing.transition(manager(), id, 'void', parseOrThrow(lifecycleRequestSchema, body));
  }

  // --- Support access (F44) --------------------------------------------------------------------------------

  @Get('support-access')
  @Header('Cache-Control', NO_STORE)
  supportList(@Query('tenantId') tenantId: unknown) {
    return this.support.list(requireStaff(), parseOrThrow(z.uuid().optional(), tenantId));
  }

  @Post('support-access')
  @HttpCode(201)
  requestSupport(@Body() body: unknown) {
    return this.support.request(requireStaff(), parseOrThrow(supportRequestSchema, body));
  }

  @Post('support-access/emergency')
  @HttpCode(201)
  emergency(@Body() body: unknown) {
    return this.support.request(sensitive('PLATFORM_OWNER'), parseOrThrow(supportRequestSchema, body), true);
  }

  @Post('support-access/:id/open')
  @HttpCode(200)
  open(@Param('id', uuid()) id: string) {
    return this.support.open(requireStaff(), id);
  }

  @Post('support-access/:id/end')
  @HttpCode(204)
  async end(@Param('id', uuid()) id: string): Promise<void> {
    await this.support.end(requireStaff(), id);
  }
}
