import { Injectable } from '@nestjs/common';
import type { DomainChangeRequestView } from '@studyhub/contracts';

import { monthRange, refundsTotal, salesTotal, toStatement } from '../../admin';
import { AppError, ConfigService, queueEmail, SecretBox, TenantDb } from '../../platform';
import { ownerContacts, planFromRow, TenantResolver } from '../../tenancy';
import { platformCommission } from '../domain/statements';
import type { ConsoleActor } from './console-auth.service';
import { slugTaken } from './console-tenants.service';
import { recordInSchool, recordPlatform } from './platform-audit';

const REDIRECT_DAYS = 90;

/** Subdomain change approvals (BR-50) and monthly platform statements (W8, BR-63) in the console. */
@Injectable()
export class ConsoleBillingService {
  constructor(
    private readonly db: TenantDb,
    private readonly config: ConfigService,
    private readonly box: SecretBox,
    private readonly resolver: TenantResolver,
  ) {}

  // --- Domain change requests ------------------------------------------------------------------------

  async domainRequests(status?: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED') {
    return this.db.runPlatform(async (tx) => {
      const rows = await tx.domainChangeRequest.findMany({
        where: status === undefined ? {} : { status },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      const tenants = await tx.tenant.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } },
        select: { id: true, name: true },
      });
      const names = new Map(tenants.map((t) => [t.id, t.name]));
      return {
        requests: rows.map((r) => ({
          ...view(r),
          tenantId: r.tenantId,
          tenantName: names.get(r.tenantId) ?? '',
        })),
      };
    });
  }

  /**
   * BR-50: approving makes `{requested}.<domain>` the primary host; the old host keeps answering with a
   * redirect for 90 days. The slug changes with it. Owners are emailed either way.
   */
  async decideDomain(
    actor: ConsoleActor,
    id: string,
    approve: boolean,
    note: string | undefined,
  ): Promise<void> {
    const request = await this.db.runPlatform((tx) => tx.domainChangeRequest.findUnique({ where: { id } }));
    if (request === null) throw new AppError('NOT_FOUND');
    if (request.status !== 'REQUESTED')
      throw new AppError('INVALID_STATE', { detail: 'This request was already decided.' });
    const suffix = this.config.get('SCHOOL_HOST_SUFFIX');
    const newHost = `${request.requestedSlug}.${suffix}`;
    const now = new Date();
    await this.db.runPlatformIn(request.tenantId, async (tx) => {
      if (approve) {
        if (await slugTaken(tx, request.requestedSlug)) throw new AppError('SLUG_TAKEN');
        const old = await tx.tenantDomain.findFirst({
          where: { tenantId: request.tenantId, isPrimary: true },
        });
        if (old !== null) {
          await tx.tenantDomain.update({
            where: { id: old.id },
            data: {
              isPrimary: false,
              status: 'REDIRECT',
              redirectUntil: new Date(now.getTime() + REDIRECT_DAYS * 86_400_000),
            },
          });
        }
        await tx.tenantDomain.create({
          data: {
            tenantId: request.tenantId,
            hostname: newHost,
            type: 'SUBDOMAIN',
            status: 'ACTIVE',
            isPrimary: true,
            verifiedAt: now,
          },
        });
        await tx.tenant.update({
          where: { id: request.tenantId },
          data: { slug: request.requestedSlug, updatedAt: now, version: { increment: 1 } },
        });
      }
      await tx.domainChangeRequest.update({
        where: { id },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          decidedBy: actor.userId,
          decidedAt: now,
          decisionNote: note ?? null,
        },
      });
      const entry = {
        actorId: actor.userId,
        action: approve ? 'domain.change_approved' : 'domain.change_rejected',
        entityType: 'domain_change_request',
        entityId: id,
        tenantRef: request.tenantId,
        before: { slug: request.currentSlug },
        after: { slug: approve ? request.requestedSlug : request.currentSlug, note: note ?? null },
      };
      await recordPlatform(tx, entry);
      await recordInSchool(tx, request.tenantId, entry);
      const school = await tx.tenant.findUnique({ where: { id: request.tenantId }, select: { name: true } });
      const primary = approve ? newHost : `${request.currentSlug}.${suffix}`;
      for (const owner of await ownerContacts(tx)) {
        await queueEmail(tx, this.box, {
          template: 'domain-decision',
          to: owner.email,
          vars: {
            schoolName: school?.name ?? '',
            displayName: owner.displayName,
            status: approve ? 'APPROVED' : 'REJECTED',
            detail: newHost,
            ...(note !== undefined && { reason: note }),
            link: `${this.config.get('SCHOOL_URL_TEMPLATE').replace('{host}', primary)}/admin/domain`,
          },
        });
      }
    });
    this.resolver.invalidate();
  }

  // --- Statements (W8) ---------------------------------------------------------------------------------

  async statements(period?: string) {
    return this.db.runPlatform(async (tx) => {
      const rows = await tx.platformStatement.findMany({
        where: period === undefined ? {} : { period },
        orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
        take: 500,
      });
      const tenants = await tx.tenant.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } },
        select: { id: true, name: true },
      });
      const names = new Map(tenants.map((t) => [t.id, t.name]));
      return {
        statements: rows.map((r) => ({
          ...toStatement(r),
          tenantId: r.tenantId,
          tenantName: names.get(r.tenantId) ?? '',
        })),
      };
    });
  }

  /**
   * Drafts one statement per live school for the month: the plan's subscription fee plus
   * platformCommissionBps × (recorded sales − refunds) (BR-63). Sums are computed inside each school;
   * only totals leave it. Schools that already have a statement for the month are skipped.
   */
  async generate(actor: ConsoleActor, period: string): Promise<{ created: number; skipped: number }> {
    const range = monthRange(period);
    if (range.start > new Date())
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'period', code: 'future', message: 'Pick a month that has started' }],
      });
    const tenants = await this.db.runPlatform((tx) =>
      tx.tenant.findMany({
        where: { status: { in: ['ACTIVE', 'SUSPENDED', 'OFFBOARDING'] }, createdAt: { lt: range.end } },
        select: { id: true, currency: true, plan: true },
      }),
    );
    let created = 0;
    let skipped = 0;
    for (const tenant of tenants) {
      const made = await this.db.runPlatformIn(tenant.id, async (tx) => {
        const existing = await tx.platformStatement.findFirst({
          where: { tenantId: tenant.id, period, status: { not: 'VOID' } },
        });
        if (existing !== null) return false;
        const plan = planFromRow(tenant.plan);
        const sales = await salesTotal(tx, range);
        const refunds = await refundsTotal(tx, range);
        const amounts = platformCommission({
          subscriptionFeeMinor: BigInt(plan.pricing.subscriptionFeeMinor),
          salesGrossMinor: sales.gross,
          refundsMinor: refunds,
          commissionBps: plan.pricing.platformCommissionBps,
        });
        const statement = await tx.platformStatement.create({
          data: {
            tenantId: tenant.id,
            period,
            planCode: plan.id === null ? null : plan.code,
            subscriptionFeeMinor: amounts.subscriptionFeeMinor,
            salesGrossMinor: sales.gross,
            refundsMinor: refunds,
            platformCommissionBps: plan.pricing.platformCommissionBps,
            platformCommissionMinor: amounts.commissionMinor,
            totalDueMinor: amounts.totalDueMinor,
            currency: tenant.currency,
            createdBy: actor.userId,
          },
          select: { id: true },
        });
        await recordPlatform(tx, {
          actorId: actor.userId,
          action: 'statement.created',
          entityType: 'platform_statement',
          entityId: statement.id,
          tenantRef: tenant.id,
          after: { period, totalDueMinor: amounts.totalDueMinor.toString() },
        });
        return true;
      });
      if (made) created += 1;
      else skipped += 1;
    }
    return { created, skipped };
  }

  async transition(
    actor: ConsoleActor,
    id: string,
    action: 'issue' | 'mark-paid' | 'void',
    input: { externalReference?: string; reason?: string },
  ): Promise<void> {
    const statement = await this.db.runPlatform((tx) => tx.platformStatement.findUnique({ where: { id } }));
    if (statement === null) throw new AppError('NOT_FOUND');
    const allowed = { issue: ['DRAFT'], 'mark-paid': ['ISSUED'], void: ['DRAFT', 'ISSUED'] }[action];
    if (!allowed.includes(statement.status)) {
      throw new AppError('INVALID_STATE', {
        detail: `A ${statement.status.toLowerCase()} statement can't be changed this way.`,
      });
    }
    const now = new Date();
    await this.db.runPlatformIn(statement.tenantId, async (tx) => {
      await tx.platformStatement.update({
        where: { id },
        data:
          action === 'issue'
            ? { status: 'ISSUED', issuedAt: now, updatedAt: now }
            : action === 'mark-paid'
              ? {
                  status: 'PAID',
                  paidAt: now,
                  externalReference: input.externalReference ?? null,
                  updatedAt: now,
                }
              : { status: 'VOID', voidedAt: now, updatedAt: now },
      });
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: `statement.${action.replace('-', '_')}`,
        entityType: 'platform_statement',
        entityId: id,
        tenantRef: statement.tenantId,
        before: { status: statement.status },
        after: { externalReference: input.externalReference ?? null, reason: input.reason ?? null },
      });
      if (action === 'issue') {
        const school = await tx.tenant.findUnique({
          where: { id: statement.tenantId },
          select: { name: true, domains: { where: { isPrimary: true }, select: { hostname: true } } },
        });
        const host = school?.domains[0]?.hostname;
        for (const owner of await ownerContacts(tx)) {
          await queueEmail(tx, this.box, {
            template: 'statement-issued',
            to: owner.email,
            vars: {
              schoolName: school?.name ?? '',
              displayName: owner.displayName,
              number: statement.period,
              amount: `${statement.currency} ${(Number(statement.totalDueMinor) / 100).toFixed(2)}`,
              link:
                host === undefined
                  ? ''
                  : `${this.config.get('SCHOOL_URL_TEMPLATE').replace('{host}', host)}/admin/billing`,
            },
          });
        }
      }
    });
  }
}

function view(r: {
  id: string;
  currentSlug: string;
  requestedSlug: string;
  reason: string;
  status: DomainChangeRequestView['status'];
  decisionNote: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}): DomainChangeRequestView {
  return {
    id: r.id,
    currentSlug: r.currentSlug,
    requestedSlug: r.requestedSlug,
    reason: r.reason,
    status: r.status,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
  };
}
