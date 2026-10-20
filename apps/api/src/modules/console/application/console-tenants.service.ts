import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  type ConsoleTenantDetail,
  type ConsoleTenantRow,
  type CreateTenantRequest,
  DEFAULT_LOCALE_SETTINGS,
  FEATURE_KEYS,
  type FeatureKey,
  type FeatureOverrideValue,
} from '@studyhub/contracts';

import { toGrant, toStatement, usageDay } from '../../admin';
import {
  AppError,
  ConfigService,
  type IssuedToken,
  issueToken,
  queueEmail,
  SecretBox,
  TenantDb,
  type TenantTx,
} from '../../platform';
import {
  featureChangeProblems,
  featureEnabled,
  featureMap,
  LATER_FEATURES,
  limitOf,
  ownerContacts,
  planFromRow,
  planGrants,
  readFeatures,
  readPlan,
  slugProblem,
  TENANT_SWITCH_DEFAULTS,
  TenantResolver,
} from '../../tenancy';
import type { ConsoleActor } from './console-auth.service';
import { recordInSchool, recordPlatform } from './platform-audit';

const INVITATION_TTL_MS = 7 * 24 * 3600_000;
const GRACE_MS = 30 * 86_400_000;

export type LifecycleAction = 'activate' | 'suspend' | 'unsuspend' | 'offboard' | 'cancel-offboarding';

type Status = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'OFFBOARDING' | 'DELETED';

/** The F37 state machine (05 §8.1): which statuses each console action starts from, and where it goes. */
export const LIFECYCLE: Record<LifecycleAction, { from: readonly Status[]; to: Status; label: string }> = {
  activate: { from: ['PROVISIONING'], to: 'ACTIVE', label: 'is now live' },
  suspend: { from: ['ACTIVE'], to: 'SUSPENDED', label: 'has been suspended' },
  unsuspend: { from: ['SUSPENDED'], to: 'ACTIVE', label: 'is active again' },
  offboard: {
    from: ['ACTIVE', 'SUSPENDED', 'PROVISIONING'],
    to: 'OFFBOARDING',
    label: 'is being offboarded',
  },
  'cancel-offboarding': { from: ['OFFBOARDING'], to: 'ACTIVE', label: 'is no longer being offboarded' },
};

/**
 * Schools as the console sees them (F37, F43; S-C03–S-C05): metadata, plan, overrides, usage and
 * lifecycle. Reads use the console realm's metadata policies (ADR-0020); writes inside a school run in a
 * console transaction that enters that school only for the write, and return no school data.
 */
@Injectable()
export class ConsoleTenantsService {
  constructor(
    private readonly db: TenantDb,
    private readonly config: ConfigService,
    private readonly box: SecretBox,
    private readonly resolver: TenantResolver,
  ) {}

  async list(query: {
    q?: string | undefined;
    status?: Status | undefined;
    plan?: string | undefined;
    kind?: string | undefined;
  }): Promise<{ tenants: ConsoleTenantRow[] }> {
    return this.db.runPlatform(async (tx) => {
      const tenants = await tx.tenant.findMany({
        where: {
          ...(query.status !== undefined && { status: query.status }),
          ...(query.kind !== undefined && { kind: query.kind as never }),
          ...(query.plan !== undefined && { plan: { code: query.plan } }),
          ...(query.q !== undefined &&
            query.q !== '' && {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { slug: { contains: query.q.toLowerCase() } },
              ],
            }),
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          kind: true,
          createdAt: true,
          plan: { select: { id: true, code: true, name: true, features: true, limits: true, pricing: true } },
          domains: { where: { isPrimary: true }, select: { hostname: true } },
        },
      });
      const latest = await latestUsage(
        tx,
        tenants.map((t) => t.id),
      );
      return {
        tenants: tenants.map((t) => {
          const usage = latest.get(t.id);
          const storageLimit = limitOf(planFromRow(t.plan).limits, 'storage');
          return {
            id: t.id,
            name: t.name,
            slug: t.slug,
            primaryHost: t.domains[0]?.hostname ?? null,
            status: t.status,
            kind: t.kind,
            planCode: t.plan?.code ?? null,
            activeLearners: usage?.activeLearners ?? null,
            storagePercent:
              usage === undefined || storageLimit === null || storageLimit === 0
                ? null
                : Math.round((Number(usage.storageBytes) / storageLimit) * 1000) / 10,
            createdAt: t.createdAt.toISOString(),
          };
        }),
      };
    });
  }

  async detail(tenantId: string): Promise<ConsoleTenantDetail> {
    return this.db.runPlatform(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        include: { plan: true, domains: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } },
      });
      if (tenant === null) throw new AppError('NOT_FOUND');
      const plan = planFromRow(tenant.plan);
      const rows = await tx.tenantFeature.findMany({ where: { tenantId } });
      const effective = featureMap(rows, plan.features);
      const byKey = new Map(rows.map((row) => [row.featureKey, row]));
      const usage = await tx.tenantUsageDaily.findMany({
        where: { tenantId, date: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        orderBy: { date: 'asc' },
      });
      const grants = await tx.supportAccessGrant.findMany({
        where: { tenantId },
        orderBy: { requestedAt: 'desc' },
        take: 50,
      });
      const requests = await tx.domainChangeRequest.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      const statements = await tx.platformStatement.findMany({
        where: { tenantId },
        orderBy: { period: 'desc' },
        take: 24,
      });
      return {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          legalName: tenant.legalName,
          slug: tenant.slug,
          kind: tenant.kind,
          status: tenant.status,
          country: tenant.country,
          currency: tenant.currency,
          receiptPrefix: tenant.receiptPrefix,
          ownerContactEmail: tenant.ownerContactEmail,
          suspendedReason: tenant.suspendedReason,
          offboardingRequestedAt: tenant.offboardingRequestedAt?.toISOString() ?? null,
          deleteAfter: tenant.deleteAfter?.toISOString() ?? null,
          activatedAt: tenant.activatedAt?.toISOString() ?? null,
          createdAt: tenant.createdAt.toISOString(),
        },
        plan: tenant.plan === null ? null : { code: tenant.plan.code, name: tenant.plan.name },
        domains: tenant.domains.map((d) => ({
          hostname: d.hostname,
          type: d.type,
          status: d.status,
          isPrimary: d.isPrimary,
          redirectUntil: d.redirectUntil?.toISOString() ?? null,
        })),
        features: FEATURE_KEYS.map((key) => {
          const row = byKey.get(key);
          return {
            key,
            planGrants: planGrants(plan.features, key),
            override: row?.platformOverride ?? 'NONE',
            enabledByTenant: row?.enabledByTenant ?? TENANT_SWITCH_DEFAULTS[key] ?? true,
            effective: effective[key],
          };
        }),
        usage: usage.map(usageDay),
        supportGrants: grants.map((g) => ({
          ...toGrant(g),
          tenantId,
          tenantName: tenant.name,
          staffId: g.platformUserId,
        })),
        domainRequests: requests.map((r) => ({
          id: r.id,
          currentSlug: r.currentSlug,
          requestedSlug: r.requestedSlug,
          reason: r.reason,
          status: r.status,
          decisionNote: r.decisionNote,
          createdAt: r.createdAt.toISOString(),
          decidedAt: r.decidedAt?.toISOString() ?? null,
        })),
        statements: statements.map(toStatement),
      };
    });
  }

  async slugAvailability(slug: string) {
    const normalised = slug.trim().toLowerCase();
    const problem = slugProblem(normalised);
    if (problem !== null) return { slug: normalised, available: false, problem };
    const taken = await this.db.runPlatform((tx) => slugTaken(tx, normalised));
    return { slug: normalised, available: !taken, problem: taken ? ('TAKEN' as const) : null };
  }

  /** F37: creates a PROVISIONING school with its host, default branding and settings, and invites its owner. */
  async create(actor: ConsoleActor, input: CreateTenantRequest) {
    const problem = slugProblem(input.slug);
    if (problem === 'RESERVED') throw new AppError('SLUG_RESERVED');
    if (problem !== null) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [
          {
            field: 'slug',
            code: problem.toLowerCase(),
            message: 'Use 3–30 lowercase letters, digits or single hyphens',
          },
        ],
      });
    }
    const hostname = `${input.slug}.${this.config.get('SCHOOL_HOST_SUFFIX')}`;
    const plan = await this.db.runPlatform(async (tx) => {
      if (await slugTaken(tx, input.slug)) throw new AppError('SLUG_TAKEN');
      const found = await tx.plan.findUnique({ where: { code: input.planCode } });
      if (found === null || found.status !== 'ACTIVE') {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'planCode', code: 'unknown', message: 'Choose an active plan' }],
        });
      }
      return found;
    });
    const tenantId = randomUUID();
    const invitation = issueToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    try {
      await this.db.runPlatformIn(tenantId, async (tx) => {
        await tx.tenant.create({
          data: {
            id: tenantId,
            slug: input.slug,
            name: input.name,
            legalName: input.legalName ?? null,
            kind: input.kind,
            status: 'PROVISIONING',
            planId: plan.id,
            country: input.country,
            currency: input.currency,
            receiptPrefix: input.receiptPrefix ?? null,
            ownerContactEmail: input.ownerEmail,
            createdBy: actor.userId,
          },
        });
        await tx.tenantDomain.create({
          data: {
            tenantId,
            hostname,
            type: 'SUBDOMAIN',
            status: 'ACTIVE',
            isPrimary: true,
            verifiedAt: new Date(),
          },
        });
        await tx.tenantBranding.create({
          data: { tenantId, displayName: input.name, status: 'PUBLISHED', publishedAt: new Date() },
        });
        for (const [key, value] of Object.entries(DEFAULT_LOCALE_SETTINGS)) {
          await tx.tenantSetting.create({ data: { tenantId, key, value: value as object } });
        }
        await this.inviteOwner(tx, tenantId, input.ownerEmail, invitation, expiresAt, hostname, input.name);
        const entry = {
          actorId: actor.userId,
          action: 'tenant.created',
          entityType: 'tenant',
          entityId: tenantId,
          tenantRef: tenantId,
          after: { slug: input.slug, name: input.name, kind: input.kind, plan: plan.code, hostname },
        };
        await recordPlatform(tx, entry);
        await recordInSchool(tx, tenantId, entry);
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new AppError('SLUG_TAKEN');
      throw error;
    }
    this.resolver.invalidate(hostname);
    return {
      id: tenantId,
      status: 'PROVISIONING' as const,
      primaryHost: hostname,
      ownerInvitation: { email: input.ownerEmail, expiresAt: expiresAt.toISOString() },
    };
  }

  /** Resends (or redirects) the owner invitation while the school is being set up. */
  async resendOwnerInvitation(actor: ConsoleActor, tenantId: string, email: string | undefined) {
    const tenant = await this.metadata(tenantId);
    const to = email ?? tenant.ownerContactEmail;
    if (to === null) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'email', code: 'required', message: 'Enter the owner email' }],
      });
    }
    const invitation = issueToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await this.db.runPlatformIn(tenantId, async (tx) => {
      await tx.invitation.updateMany({
        where: { role: 'TENANT_OWNER', acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (email !== undefined)
        await tx.tenant
          .update({ where: { id: tenantId }, data: { ownerContactEmail: email } })
          .catch(() => undefined);
      await this.inviteOwner(tx, tenantId, to, invitation, expiresAt, tenant.primaryHost, tenant.name);
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'tenant.owner_invited',
        entityType: 'tenant',
        entityId: tenantId,
        tenantRef: tenantId,
      });
    });
    return { email: to, expiresAt: expiresAt.toISOString() };
  }

  /** F37 lifecycle (reason required): platform log, the school's log and an email to its owners. */
  async lifecycle(
    actor: ConsoleActor,
    tenantId: string,
    action: LifecycleAction,
    reason: string,
  ): Promise<{ status: Status }> {
    const rule = LIFECYCLE[action];
    const tenant = await this.metadata(tenantId);
    if (!rule.from.includes(tenant.status)) {
      throw new AppError('INVALID_STATE', {
        detail: `A ${tenant.status.toLowerCase()} school can't be changed this way.`,
      });
    }
    if (action === 'cancel-offboarding' && tenant.deleteAfter !== null && tenant.deleteAfter < new Date()) {
      throw new AppError('INVALID_STATE', { detail: 'The grace period has ended.' });
    }
    const now = new Date();
    await this.db.runPlatformIn(tenantId, async (tx) => {
      if (action === 'cancel-offboarding') {
        const [locked] = await tx.$queryRaw<{ status: string; eligible: boolean }[]>`
          SELECT status, (delete_after > clock_timestamp()) AS eligible FROM tenant
          WHERE id = ${tenantId}::uuid FOR UPDATE`;
        if (locked?.status !== 'OFFBOARDING' || !locked.eligible)
          throw new AppError('INVALID_STATE', {
            detail: 'The grace period has ended or offboarding was already changed.',
          });
      }
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          status: rule.to,
          updatedAt: now,
          version: { increment: 1 },
          ...(action === 'activate' && { activatedAt: now }),
          ...(action === 'suspend' && { suspendedReason: reason }),
          ...(action === 'unsuspend' && { suspendedReason: null }),
          ...(action === 'offboard' && {
            offboardingRequestedAt: now,
            deleteAfter: new Date(now.getTime() + GRACE_MS),
          }),
          ...(action === 'cancel-offboarding' && { offboardingRequestedAt: null, deleteAfter: null }),
        },
      });
      const entry = {
        actorId: actor.userId,
        action: `tenant.${action.replace('-', '_')}`,
        entityType: 'tenant',
        entityId: tenantId,
        tenantRef: tenantId,
        before: { status: tenant.status },
        after: { status: rule.to, reason },
      };
      await recordPlatform(tx, entry);
      await recordInSchool(tx, tenantId, entry);
      for (const owner of await ownerContacts(tx)) {
        await queueEmail(tx, this.box, {
          template: 'school-status',
          to: owner.email,
          vars: {
            schoolName: tenant.name,
            displayName: owner.displayName,
            status: `${tenant.name} ${rule.label}`,
            detail: `${tenant.name} ${rule.label}.`,
            reason,
            link: this.link(tenant.primaryHost, '/admin'),
          },
        });
      }
    });
    this.resolver.invalidate();
    return { status: rule.to };
  }

  async patch(
    actor: ConsoleActor,
    tenantId: string,
    input: {
      name?: string | undefined;
      legalName?: string | null | undefined;
      planCode?: string | undefined;
      receiptPrefix?: string | null | undefined;
      reason: string;
    },
  ): Promise<void> {
    const tenant = await this.metadata(tenantId);
    await this.db.runPlatformIn(tenantId, async (tx) => {
      const plan =
        input.planCode === undefined
          ? undefined
          : await tx.plan.findUnique({ where: { code: input.planCode } });
      if (plan === null || (plan !== undefined && plan.status !== 'ACTIVE')) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'planCode', code: 'unknown', message: 'Choose an active plan' }],
        });
      }
      const data = {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.legalName !== undefined && { legalName: input.legalName }),
        ...(input.receiptPrefix !== undefined && { receiptPrefix: input.receiptPrefix }),
        ...(plan !== undefined && { planId: plan.id }),
      };
      if (Object.keys(data).length === 0) return;
      await tx.tenant.update({
        where: { id: tenantId },
        data: { ...data, updatedAt: new Date(), version: { increment: 1 } },
      });
      const entry = {
        actorId: actor.userId,
        action: 'tenant.updated',
        entityType: 'tenant',
        entityId: tenantId,
        tenantRef: tenantId,
        before: { name: tenant.name, planCode: tenant.planCode },
        after: { ...input, reason: input.reason },
      };
      await recordPlatform(tx, entry);
      await recordInSchool(tx, tenantId, entry);
    });
  }

  /** BR-48: the platform grants or revokes a feature for one school, whatever its plan. */
  async setOverride(
    actor: ConsoleActor,
    tenantId: string,
    key: FeatureKey,
    override: FeatureOverrideValue,
    reason: string,
  ) {
    await this.metadata(tenantId);
    await this.db.runPlatformIn(tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`features:${tenantId}`}))`;
      if (override === 'GRANT' && LATER_FEATURES.has(key)) {
        throw new AppError('FEATURE_NOT_ENABLED', {
          detail: 'This capability has not been implemented and cannot be granted.',
          extensions: { feature: key },
        });
      }
      const before = await tx.tenantFeature.findUnique({
        where: { tenantId_featureKey: { tenantId, featureKey: key } },
      });
      const current = await readFeatures(tx);
      const enabled = featureEnabled(
        {
          enabledByTenant: before?.enabledByTenant ?? TENANT_SWITCH_DEFAULTS[key] ?? true,
          platformOverride: override,
        },
        planGrants((await readPlan(tx)).features, key),
      );
      const problems =
        override === 'GRANT' || current[key] !== enabled
          ? featureChangeProblems(current, key, override === 'GRANT' || enabled)
          : [];
      if (problems.length > 0) {
        throw new AppError('VALIDATION_FAILED', {
          errors: problems.map((problem) => ({
            field: 'override',
            code: problem.code,
            message:
              problem.code === 'dependency_disabled'
                ? `Enable ${problem.feature} before granting ${key}.`
                : `Disable ${problem.feature} before removing ${key}.`,
          })),
        });
      }
      await tx.tenantFeature.upsert({
        where: { tenantId_featureKey: { tenantId, featureKey: key } },
        create: {
          tenantId,
          featureKey: key,
          platformOverride: override,
          enabledByTenant: TENANT_SWITCH_DEFAULTS[key] ?? true,
          updatedBy: actor.userId,
        },
        update: { platformOverride: override, updatedBy: actor.userId, updatedAt: new Date() },
      });
      const entry = {
        actorId: actor.userId,
        action: 'tenant.feature_override',
        entityType: 'tenant_feature',
        entityId: key,
        tenantRef: tenantId,
        before: { override: before?.platformOverride ?? 'NONE' },
        after: { override, reason },
      };
      await recordPlatform(tx, entry);
      await recordInSchool(tx, tenantId, entry);
    });
  }

  private async inviteOwner(
    tx: TenantTx,
    tenantId: string,
    email: string,
    invitation: IssuedToken,
    expiresAt: Date,
    host: string | null,
    schoolName: string,
  ): Promise<void> {
    await tx.invitation.create({
      data: { tenantId, email, role: 'TENANT_OWNER', tokenHash: invitation.hash, expiresAt },
    });
    await queueEmail(tx, this.box, {
      template: 'invitation',
      to: email,
      vars: {
        schoolName,
        roleLabel: 'the owner',
        link: this.link(host, `/invitations/accept#token=${invitation.token}`),
      },
    });
  }

  private link(host: string | null, path: string): string {
    return host === null ? '' : `${this.config.get('SCHOOL_URL_TEMPLATE').replace('{host}', host)}${path}`;
  }

  private async metadata(tenantId: string) {
    const tenant = await this.db.runPlatform((tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          status: true,
          deleteAfter: true,
          ownerContactEmail: true,
          plan: { select: { code: true } },
          domains: { where: { isPrimary: true, status: 'ACTIVE' }, select: { hostname: true } },
        },
      }),
    );
    if (tenant === null || tenant.status === 'DELETED') throw new AppError('NOT_FOUND');
    return {
      ...tenant,
      status: tenant.status,
      planCode: tenant.plan?.code ?? null,
      primaryHost: tenant.domains[0]?.hostname ?? null,
    };
  }
}

export async function slugTaken(tx: TenantTx, slug: string): Promise<boolean> {
  const tenant = await tx.tenant.findFirst({ where: { slug }, select: { id: true } });
  if (tenant !== null) return true;
  const hosts = await tx.tenantDomain.findMany({
    where: { hostname: { startsWith: `${slug}.` } },
    select: { id: true },
    take: 1,
  });
  return hosts.length > 0;
}

/** The newest usage row of each school (console columns). */
export async function latestUsage(tx: TenantTx, tenantIds: string[]) {
  if (tenantIds.length === 0) return new Map<string, { activeLearners: number; storageBytes: bigint }>();
  const rows = await tx.tenantUsageDaily.findMany({
    where: { tenantId: { in: tenantIds } },
    orderBy: { date: 'desc' },
    distinct: ['tenantId'],
    select: { tenantId: true, activeLearners: true, storageBytes: true },
  });
  return new Map(rows.map((r) => [r.tenantId, r]));
}
