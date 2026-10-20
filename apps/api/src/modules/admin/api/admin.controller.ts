import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  auditQuerySchema,
  brandingDraftSchema,
  createExportRequestSchema,
  domainChangeRequestSchema,
  featureKeySchema,
  legalPageSchema,
  markReadRequestSchema,
  notificationPreferencesSchema,
  offboardingRequestSchema,
  putLocalesRequestSchema,
  reasonRequestSchema,
  reportQuerySchema,
  setFeatureRequestSchema,
  supportDecisionRequestSchema,
  tenantRoleSchema,
  validateColourRequestSchema,
} from '@studyhub/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  AppError,
  parseOrThrow,
  requireTenantId,
  STORAGE_LOCATIONS,
  type StorageLocations,
  TenantDb,
} from '../../platform';
import { AuditLogService } from '../application/audit-log.service';
import { BrandingService, colourReport } from '../application/branding.service';
import { ExportsService } from '../application/exports.service';
import { FeaturesService } from '../application/features.service';
import { requireActor, requireAdmin } from '../application/guards';
import { NotificationsService } from '../application/notifications.service';
import { QueuesService } from '../application/queues.service';
import { ReportsService } from '../application/reports.service';
import { SchoolService } from '../application/school.service';
import { SupportAccessService } from '../application/support-access.service';
import { UsageService } from '../application/usage';
import { UsersService } from '../application/users.service';

const uuid = () => new ParseUUIDPipe();
const NO_STORE = 'private, no-store';

/** School administration (05 §4.9, §8.3; M9). Every mutation writes one entry in the school's audit log. */
@Controller('api/v1/admin')
export class AdminController {
  constructor(
    private readonly branding: BrandingService,
    private readonly features: FeaturesService,
    private readonly users: UsersService,
    private readonly queues: QueuesService,
    private readonly reports: ReportsService,
    private readonly exports: ExportsService,
    private readonly auditLog: AuditLogService,
    private readonly support: SupportAccessService,
    private readonly usageService: UsageService,
    private readonly school: SchoolService,
  ) {}

  // --- Branding (F39, S-AD12) ----------------------------------------------------------------------

  @Get('branding')
  @Header('Cache-Control', NO_STORE)
  brandingEditor() {
    return this.branding.editor(requireActor());
  }

  @Put('branding/draft')
  @HttpCode(204)
  async saveDraft(@Body() body: unknown): Promise<void> {
    await this.branding.saveDraft(requireActor(), parseOrThrow(brandingDraftSchema, body));
  }

  @Post('branding/publish')
  @HttpCode(200)
  publish() {
    return this.branding.publish(requireActor());
  }

  @Post('branding/rollback/:version')
  @HttpCode(200)
  rollback(@Param('version') version: string) {
    return this.branding.rollback(requireActor(), parseOrThrow(z.coerce.number().int().min(1), version));
  }

  @Post('branding/validate-colour')
  @HttpCode(200)
  validateColour(@Body() body: unknown) {
    requireAdmin(requireActor());
    return colourReport(parseOrThrow(validateColourRequestSchema, body).accentHex);
  }

  // --- Features and languages (F40, BR-61) -------------------------------------------------------------

  @Get('features')
  @Header('Cache-Control', NO_STORE)
  featureList() {
    return this.features.list(requireActor());
  }

  @Put('features/:key')
  @HttpCode(204)
  async setFeature(@Param('key') key: string, @Body() body: unknown): Promise<void> {
    const feature = parseOrThrow(featureKeySchema, key);
    await this.features.set(requireActor(), feature, parseOrThrow(setFeatureRequestSchema, body).enabled);
  }

  @Get('locales')
  @Header('Cache-Control', NO_STORE)
  locales() {
    return this.features.locales(requireActor());
  }

  @Put('locales')
  @HttpCode(204)
  async setLocales(@Body() body: unknown): Promise<void> {
    await this.features.setLocales(requireActor(), parseOrThrow(putLocalesRequestSchema, body));
  }

  // --- Users (F30, S-AD03) -------------------------------------------------------------------------------

  @Get('users')
  @Header('Cache-Control', NO_STORE)
  userList(
    @Query('q') q: unknown,
    @Query('role') role: unknown,
    @Query('status') status: unknown,
    @Query('page') page: unknown,
  ) {
    return this.users.search(requireActor(), {
      q: parseOrThrow(z.string().max(120).optional(), q),
      role: parseOrThrow(tenantRoleSchema.optional(), role),
      status: parseOrThrow(z.enum(['ACTIVE', 'SUSPENDED']).optional(), status),
      page: parseOrThrow(z.coerce.number().int().min(1).max(1000).default(1), page),
    });
  }

  @Get('users/:membershipId')
  @Header('Cache-Control', NO_STORE)
  userDetail(@Param('membershipId', uuid()) membershipId: string) {
    return this.users.detail(requireActor(), membershipId);
  }

  @Post('users/:membershipId/suspend')
  @HttpCode(204)
  async suspend(@Param('membershipId', uuid()) membershipId: string, @Body() body: unknown): Promise<void> {
    const { reason } = parseOrThrow(reasonRequestSchema, body);
    await this.users.setSuspended(requireActor(), membershipId, true, reason);
  }

  @Post('users/:membershipId/unsuspend')
  @HttpCode(204)
  async unsuspend(@Param('membershipId', uuid()) membershipId: string, @Body() body: unknown): Promise<void> {
    const { reason } = parseOrThrow(reasonRequestSchema, body);
    await this.users.setSuspended(requireActor(), membershipId, false, reason);
  }

  @Post('users/:membershipId/resend-verification')
  @HttpCode(202)
  async resendVerification(
    @Param('membershipId', uuid()) membershipId: string,
    @Req() request: FastifyRequest,
  ) {
    await this.users.resendVerification(requireActor(), membershipId, request.host);
    return { status: 'ACCEPTED' };
  }

  @Delete('users/:membershipId/sessions/:sessionId')
  @HttpCode(204)
  async revokeSession(
    @Param('membershipId', uuid()) membershipId: string,
    @Param('sessionId', uuid()) sessionId: string,
  ): Promise<void> {
    await this.users.revokeSession(requireActor(), membershipId, sessionId);
  }

  // --- Queues, reports, exports, audit (F31, F32, F34) -------------------------------------------------

  @Get('queues/summary')
  @Header('Cache-Control', NO_STORE)
  queueSummary() {
    return this.queues.summary(requireActor());
  }

  @Get('reports/overview')
  @Header('Cache-Control', NO_STORE)
  overview(@Query() query: unknown) {
    return this.reports.overview(requireActor(), parseOrThrow(reportQuerySchema, query));
  }

  @Get('exports')
  @Header('Cache-Control', NO_STORE)
  exportList() {
    return this.exports.list(requireActor());
  }

  @Post('exports')
  @HttpCode(201)
  createExport(@Body() body: unknown) {
    return this.exports.createReport(requireActor(), parseOrThrow(createExportRequestSchema, body));
  }

  @Post('exports/tenant')
  @HttpCode(201)
  createFullExport() {
    return this.exports.createFull(requireActor());
  }

  @Get('exports/:id')
  @Header('Cache-Control', NO_STORE)
  getExport(@Param('id', uuid()) id: string) {
    return this.exports.get(requireActor(), id);
  }

  @Get('audit-log')
  @Header('Cache-Control', NO_STORE)
  audit(@Query() query: unknown) {
    return this.auditLog.page(requireActor(), parseOrThrow(auditQuerySchema, query));
  }

  // --- Support access (F44, S-AD16) -------------------------------------------------------------------

  @Get('support-access')
  @Header('Cache-Control', NO_STORE)
  supportGrants() {
    return this.support.list(requireActor());
  }

  @Post('support-access/:id/decision')
  @HttpCode(200)
  decideSupport(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const { decision } = parseOrThrow(supportDecisionRequestSchema, body);
    return this.support.decide(requireActor(), id, decision === 'APPROVE');
  }

  @Post('support-access/:id/revoke')
  @HttpCode(200)
  revokeSupport(@Param('id', uuid()) id: string) {
    return this.support.revoke(requireActor(), id);
  }

  // --- Usage, onboarding, domains, offboarding, billing ---------------------------------------------------

  @Get('usage')
  @Header('Cache-Control', NO_STORE)
  usage() {
    return this.usageService.usage(requireActor());
  }

  @Get('plan')
  @Header('Cache-Control', NO_STORE)
  async plan() {
    return (await this.usageService.usage(requireActor())).plan;
  }

  @Get('onboarding')
  @Header('Cache-Control', NO_STORE)
  onboarding() {
    return this.school.onboarding(requireActor());
  }

  @Post('onboarding/go-live')
  @HttpCode(204)
  async goLive(): Promise<void> {
    await this.school.goLive(requireActor());
  }

  @Get('domains')
  @Header('Cache-Control', NO_STORE)
  domains() {
    return this.school.domains(requireActor());
  }

  @Get('domains/availability')
  @Header('Cache-Control', NO_STORE)
  availability(@Query('slug') slug: unknown) {
    return this.school.slugAvailability(requireActor(), parseOrThrow(z.string().min(1).max(63), slug));
  }

  @Post('domains/change-requests')
  @HttpCode(201)
  requestSlug(@Body() body: unknown) {
    return this.school.requestSlugChange(requireActor(), parseOrThrow(domainChangeRequestSchema, body));
  }

  @Post('domains/change-requests/:id/cancel')
  @HttpCode(204)
  async cancelSlug(@Param('id', uuid()) id: string): Promise<void> {
    await this.school.cancelSlugChange(requireActor(), id);
  }

  /** Custom domains (05 §8.3): specified now, implemented when `customDomain` exists (LATER, Q-TEN-5). */
  @Post('domains')
  @HttpCode(201)
  addDomain() {
    requireActor();
    throw new AppError('FEATURE_NOT_ENABLED', { extensions: { feature: 'customDomain' } });
  }

  @Get('offboarding')
  @Header('Cache-Control', NO_STORE)
  offboarding() {
    return this.school.offboarding(requireActor());
  }

  @Post('offboarding')
  @HttpCode(200)
  requestOffboarding(@Body() body: unknown) {
    return this.school.requestOffboarding(
      requireActor(),
      parseOrThrow(offboardingRequestSchema, body).confirmName,
    );
  }

  @Delete('offboarding')
  @HttpCode(200)
  cancelOffboarding() {
    return this.school.cancelOffboarding(requireActor());
  }

  @Get('billing/statements')
  @Header('Cache-Control', NO_STORE)
  statements() {
    return this.school.statements(requireActor());
  }

  @Get('billing/statements/:id')
  @Header('Cache-Control', NO_STORE)
  statement(@Param('id', uuid()) id: string) {
    return this.school.statement(requireActor(), id);
  }
}

/** Member-facing notification centre (F33) and public school pages (legal texts, brand images). */
@Controller('api/v1')
export class SchoolPublicController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly school: SchoolService,
    private readonly db: TenantDb,
    @Inject(STORAGE_LOCATIONS) private readonly locations: StorageLocations,
  ) {}

  @Get('me/notifications')
  @Header('Cache-Control', NO_STORE)
  notificationList() {
    return this.notifications.list(requireActor());
  }

  @Post('me/notifications/read')
  @HttpCode(204)
  async markRead(@Body() body: unknown): Promise<void> {
    await this.notifications.markRead(requireActor(), parseOrThrow(markReadRequestSchema, body));
  }

  @Get('me/notification-preferences')
  @Header('Cache-Control', NO_STORE)
  preferences() {
    return this.notifications.preferences(requireActor());
  }

  @Put('me/notification-preferences')
  @HttpCode(200)
  setPreferences(@Body() body: unknown) {
    return this.notifications.setPreferences(
      requireActor(),
      parseOrThrow(notificationPreferencesSchema, body),
    );
  }

  @Get('legal/:page')
  @Header('Cache-Control', 'public, max-age=60')
  legal(@Param('page') page: string, @Query('locale') locale: unknown) {
    return this.school.legalPage(
      parseOrThrow(legalPageSchema, page),
      parseOrThrow(z.string().max(10).optional(), locale),
    );
  }

  /**
   * The school's published logos and icons (F39), served from its own host: a short redirect to the
   * object store. Only images the published branding uses are served (no listing of other assets).
   */
  @Get('tenant/brand/:assetId')
  async brandAsset(@Param('assetId', uuid()) assetId: string, @Res() reply: FastifyReply): Promise<void> {
    const location = await this.db.run(async (tx) => {
      const branding = await tx.tenantBranding.findFirst({
        select: { logoAssetId: true, logoDarkAssetId: true, faviconAssetId: true, appIconAssetId: true },
      });
      const used = branding !== null && Object.values(branding).includes(assetId);
      if (!used) return null;
      const asset = await tx.asset.findFirst({
        where: { id: assetId, purpose: 'BRANDING', status: 'READY' },
        select: { storageKey: true, derivativeKey: true, storageLocationId: true },
      });
      const key = asset?.derivativeKey ?? asset?.storageKey ?? null;
      return asset === null || key === null ? null : { key, locationId: asset.storageLocationId };
    });
    if (location === null) throw new AppError('NOT_FOUND');
    const storage = await this.locations.at(location.locationId, requireTenantId());
    const url = await storage.presignGet(location.key, { expiresSeconds: 3600 });
    void reply.header('Cache-Control', 'public, max-age=300').redirect(url, 302);
  }
}
