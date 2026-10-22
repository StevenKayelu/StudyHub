import { Injectable } from '@nestjs/common';
import {
  type AdminDomains,
  generalSettingsFrom,
  type Onboarding,
  type OffboardingView,
  type Statement,
} from '@studyhub/contracts';

import { AuditService } from '../../audit';
import type { TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import { readFeatures, slugProblem, TenantResolver } from '../../tenancy';
import { requireAdmin, requireOwner } from './guards';

/** BR-53: 30 days of read-only grace before deletion. */
export const OFFBOARDING_GRACE_DAYS = 30;

export function toStatement(row: {
  id: string;
  period: string;
  planCode: string | null;
  subscriptionFeeMinor: bigint;
  salesGrossMinor: bigint;
  refundsMinor: bigint;
  platformCommissionBps: number;
  platformCommissionMinor: bigint;
  totalDueMinor: bigint;
  currency: string;
  status: Statement['status'];
  issuedAt: Date | null;
  paidAt: Date | null;
  externalReference: string | null;
}): Statement {
  return {
    id: row.id,
    period: row.period,
    planCode: row.planCode,
    subscriptionFeeMinor: Number(row.subscriptionFeeMinor),
    salesGrossMinor: Number(row.salesGrossMinor),
    refundsMinor: Number(row.refundsMinor),
    platformCommissionBps: row.platformCommissionBps,
    platformCommissionMinor: Number(row.platformCommissionMinor),
    totalDueMinor: Number(row.totalDueMinor),
    currency: row.currency,
    status: row.status,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    externalReference: row.externalReference,
  };
}

/**
 * The school's own lifecycle screens: onboarding checklist and go-live (S-AD11), domains and subdomain
 * change requests (S-AD19, BR-50), offboarding (S-AD18, BR-53) and billing statements (S-AD21, W8).
 */
@Injectable()
export class SchoolService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly resolver: TenantResolver,
  ) {}

  // --- Onboarding (S-AD11) ------------------------------------------------------------------------

  async onboarding(actor: TenantActor): Promise<Onboarding> {
    requireAdmin(actor);
    return this.db.run((tx) => onboardingState(tx));
  }

  /** "Go live" (M9 PROPOSED 3, Q-TEN-10): the owner activates once the required steps are done. */
  async goLive(actor: TenantActor): Promise<void> {
    requireOwner(actor);
    await this.db.run(async (tx) => {
      const state = await onboardingState(tx);
      if (state.status !== 'PROVISIONING') {
        throw new AppError('INVALID_STATE', { detail: 'Your school is already live.' });
      }
      // SaaS billing (docs/design/saas-billing.md): a contract may require its setup invoice paid first.
      const [gate] = await tx.$queryRaw<{ blocked: boolean }[]>`
        SELECT (c.activation_policy = 'AFTER_SETUP_PAYMENT' AND s.setup_paid_at IS NULL) AS blocked
          FROM tenant_subscription s JOIN tenant_contract c ON c.id = s.contract_id
         WHERE s.status <> 'CANCELLED' ORDER BY s.created_at DESC LIMIT 1`;
      if (gate?.blocked === true) throw new AppError('SETUP_PAYMENT_REQUIRED');
      if (!state.canGoLive) throw new AppError('ONBOARDING_INCOMPLETE');
      const now = new Date();
      await tx.tenant.update({
        where: { id: requireTenantId() },
        data: { status: 'ACTIVE', activatedAt: now, updatedAt: now, version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'tenant.activated',
        entityType: 'tenant',
        entityId: requireTenantId(),
        actorId: actor.userId,
        before: { status: 'PROVISIONING' },
        after: { status: 'ACTIVE', by: 'owner' },
      });
    });
    this.resolver.invalidate();
  }

  // --- Domains (S-AD19) ----------------------------------------------------------------------------

  async domains(actor: TenantActor): Promise<AdminDomains> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const tenant = await tx.tenant.findFirst({ select: { slug: true } });
      const domains = await tx.tenantDomain.findMany({
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      });
      const requests = await tx.domainChangeRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
      return {
        slug: tenant?.slug ?? '',
        domains: domains.map((d) => ({
          hostname: d.hostname,
          type: d.type,
          status: d.status,
          isPrimary: d.isPrimary,
          redirectUntil: d.redirectUntil?.toISOString() ?? null,
        })),
        requests: requests.map((r) => ({
          id: r.id,
          currentSlug: r.currentSlug,
          requestedSlug: r.requestedSlug,
          reason: r.reason,
          status: r.status,
          decisionNote: r.decisionNote,
          createdAt: r.createdAt.toISOString(),
          decidedAt: r.decidedAt?.toISOString() ?? null,
        })),
        customDomainsEnabled: (await readFeatures(tx)).customDomain,
      };
    });
  }

  async slugAvailability(actor: TenantActor, slug: string) {
    requireAdmin(actor);
    const normalised = slug.trim().toLowerCase();
    const problem = slugProblem(normalised);
    if (problem !== null) return { slug: normalised, available: false, problem };
    const available = await this.db.run((tx) => slugAvailable(tx, normalised));
    return { slug: normalised, available, problem: available ? null : ('TAKEN' as const) };
  }

  async requestSlugChange(
    actor: TenantActor,
    input: { requestedSlug: string; reason: string },
  ): Promise<{ id: string }> {
    requireOwner(actor);
    const problem = slugProblem(input.requestedSlug);
    if (problem !== null) {
      throw new AppError(problem === 'RESERVED' ? 'SLUG_RESERVED' : 'VALIDATION_FAILED', {
        errors: [{ field: 'requestedSlug', code: problem.toLowerCase(), message: 'Choose another address' }],
      });
    }
    return this.db.run(async (tx) => {
      if (!(await slugAvailable(tx, input.requestedSlug))) throw new AppError('SLUG_TAKEN');
      const tenant = await tx.tenant.findFirst({ select: { slug: true } });
      const open = await tx.domainChangeRequest.findFirst({
        where: { status: 'REQUESTED' },
        select: { id: true },
      });
      if (open !== null) {
        throw new AppError('INVALID_STATE', { detail: 'You already have a request waiting for a decision.' });
      }
      const created = await tx.domainChangeRequest.create({
        data: {
          tenantId: requireTenantId(),
          currentSlug: tenant?.slug ?? '',
          requestedSlug: input.requestedSlug,
          reason: input.reason,
          requestedBy: actor.membershipId,
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'domain.change_requested',
        entityType: 'domain_change_request',
        entityId: created.id,
        actorId: actor.userId,
        after: { requestedSlug: input.requestedSlug, reason: input.reason },
      });
      return created;
    });
  }

  async cancelSlugChange(actor: TenantActor, id: string): Promise<void> {
    requireOwner(actor);
    await this.db.run(async (tx) => {
      const updated = await tx.domainChangeRequest.updateMany({
        where: { id, status: 'REQUESTED' },
        data: { status: 'CANCELLED', decidedAt: new Date() },
      });
      if (updated.count === 0) throw new AppError('NOT_FOUND');
      await this.audit.record(tx, {
        action: 'domain.change_cancelled',
        entityType: 'domain_change_request',
        entityId: id,
        actorId: actor.userId,
      });
    });
  }

  // --- Offboarding (S-AD18, F46, BR-53) ---------------------------------------------------------------

  async offboarding(actor: TenantActor): Promise<OffboardingView> {
    requireAdmin(actor);
    const tenant = await this.db.run((tx) =>
      tx.tenant.findFirst({ select: { status: true, offboardingRequestedAt: true, deleteAfter: true } }),
    );
    if (tenant === null) throw new AppError('NOT_FOUND');
    return {
      status: tenant.status,
      requestedAt: tenant.offboardingRequestedAt?.toISOString() ?? null,
      deleteAfter: tenant.deleteAfter?.toISOString() ?? null,
      graceDays: OFFBOARDING_GRACE_DAYS,
    };
  }

  async requestOffboarding(actor: TenantActor, confirmName: string): Promise<OffboardingView> {
    requireOwner(actor);
    await this.db.run(async (tx) => {
      const tenant = await tx.tenant.findFirst({ select: { id: true, name: true, status: true } });
      if (tenant === null) throw new AppError('NOT_FOUND');
      if (confirmName.trim() !== tenant.name) {
        throw new AppError('CONFIRMATION_MISMATCH', {
          errors: [
            { field: 'confirmName', code: 'mismatch', message: 'Type the school name exactly as shown' },
          ],
        });
      }
      if (tenant.status !== 'ACTIVE' && tenant.status !== 'PROVISIONING') {
        throw new AppError('INVALID_STATE', { detail: 'Offboarding has already been requested.' });
      }
      const now = new Date();
      const deleteAfter = new Date(now.getTime() + OFFBOARDING_GRACE_DAYS * 86_400_000);
      await tx.tenant.update({
        where: { id: tenant.id },
        data: {
          status: 'OFFBOARDING',
          offboardingRequestedAt: now,
          deleteAfter,
          updatedAt: now,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'tenant.offboarding_requested',
        entityType: 'tenant',
        entityId: tenant.id,
        actorId: actor.userId,
        before: { status: tenant.status },
        after: { status: 'OFFBOARDING', deleteAfter: deleteAfter.toISOString() },
      });
    });
    this.resolver.invalidate();
    return this.offboarding(actor);
  }

  async cancelOffboarding(actor: TenantActor): Promise<OffboardingView> {
    requireOwner(actor);
    await this.db.run(async (tx) => {
      const [tenant] = await tx.$queryRaw<
        { id: string; status: string; deleteAfter: Date | null; checkedAt: Date }[]
      >`
        SELECT id, status, delete_after AS "deleteAfter", clock_timestamp() AS "checkedAt"
        FROM tenant WHERE id = ${requireTenantId()}::uuid FOR UPDATE`;
      if (
        tenant?.status !== 'OFFBOARDING' ||
        tenant.deleteAfter === null ||
        tenant.deleteAfter <= tenant.checkedAt
      ) {
        throw new AppError('INVALID_STATE', { detail: 'There is no offboarding to cancel.' });
      }
      const now = new Date();
      await tx.tenant.update({
        where: { id: tenant.id },
        data: {
          status: 'ACTIVE',
          offboardingRequestedAt: null,
          deleteAfter: null,
          updatedAt: now,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'tenant.offboarding_cancelled',
        entityType: 'tenant',
        entityId: tenant.id,
        actorId: actor.userId,
        before: { status: 'OFFBOARDING' },
        after: { status: 'ACTIVE' },
      });
    });
    this.resolver.invalidate();
    return this.offboarding(actor);
  }

  // --- Billing (S-AD21, W8) ---------------------------------------------------------------------------

  async statements(actor: TenantActor): Promise<{ statements: Statement[] }> {
    requireOwner(actor);
    const rows = await this.db.run((tx) =>
      tx.platformStatement.findMany({ where: { status: { not: 'DRAFT' } }, orderBy: { period: 'desc' } }),
    );
    return { statements: rows.map(toStatement) };
  }

  async statement(actor: TenantActor, id: string): Promise<Statement> {
    requireOwner(actor);
    const row = await this.db.run((tx) =>
      tx.platformStatement.findFirst({ where: { id, status: { not: 'DRAFT' } } }),
    );
    if (row === null) throw new AppError('NOT_FOUND');
    return toStatement(row);
  }

  // --- Public legal pages (F36 per school) --------------------------------------------------------------

  async legalPage(page: 'terms' | 'privacy' | 'refunds', locale: string | undefined) {
    const settings = await this.db.run(async (tx) =>
      generalSettingsFrom(
        await tx.tenantSetting.findMany({ where: { key: 'legalPages' }, select: { key: true, value: true } }),
      ),
    );
    const text = settings.legalPages[page];
    const body =
      text === undefined
        ? null
        : ((locale !== undefined ? text[locale] : undefined) ?? Object.values(text)[0] ?? null);
    return { page, body };
  }
}

export async function slugAvailable(tx: TenantTx, slug: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ available: boolean }[]>`SELECT slug_available(${slug}) AS available`;
  return row?.available === true;
}

/** The checklist: required steps decide whether the school can go live. */
export async function onboardingState(tx: TenantTx): Promise<Onboarding> {
  const tenant = await tx.tenant.findFirst({ select: { status: true } });
  const branding = await tx.tenantBranding.findFirst({
    select: { version: true, logoAssetId: true, accentHex: true },
  });
  const legal = generalSettingsFrom(
    await tx.tenantSetting.findMany({ where: { key: 'legalPages' }, select: { key: true, value: true } }),
  ).legalPages;
  const features = await readFeatures(tx);
  const account = await tx.paymentAccount.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } });
  const instructors =
    (await tx.membershipRole.count({ where: { role: 'INSTRUCTOR', membership: { status: 'ACTIVE' } } })) +
    (await tx.invitation.count({ where: { role: 'INSTRUCTOR', revokedAt: null } }));
  const published = await tx.course.count({ where: { status: 'PUBLISHED' } });
  const steps: Onboarding['steps'] = [
    {
      key: 'branding',
      done: (branding?.version ?? 1) > 1 || Boolean(branding?.logoAssetId) || Boolean(branding?.accentHex),
      required: true,
    },
    { key: 'policies', done: legal.terms !== undefined && legal.privacy !== undefined, required: true },
    // Optional: free-only schools skip it, and paid courses can't be published without it anyway (BR-54).
    { key: 'payments', done: account !== null || !features.paidCourses, required: false },
    { key: 'instructors', done: instructors > 0, required: false },
    { key: 'course', done: published > 0, required: false },
  ];
  return {
    status: tenant?.status ?? 'PROVISIONING',
    steps,
    canGoLive: tenant?.status === 'PROVISIONING' && steps.every((step) => !step.required || step.done),
  };
}
