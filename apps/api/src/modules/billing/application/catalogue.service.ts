import { Injectable } from '@nestjs/common';
import {
  commercialPlanInputSchema,
  type ContractInput,
  type PlanComponent,
  planComponentSchema,
  type PlanVersionInput,
} from '@studyhub/contracts';
import { z } from 'zod';

import { type ConsoleActor, recordInSchool, recordPlatform } from '../../console';
import { AppError, TenantDb, type TenantTx } from '../../platform';
import { mergeComponents } from '../domain/pricing';

const componentsSchema = z.array(planComponentSchema);

/** A component list as stored (validated again on read: stored JSON is never trusted blindly). */
export function storedComponents(json: unknown): PlanComponent[] {
  return componentsSchema.parse(json);
}

function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code: 'invalid', message }] });
}

/**
 * Commercial plans, their versions and school contracts (docs/design/saas-billing.md §3, §5.2).
 * Platform staff only; every change is in the platform audit log (and the school's, for contracts).
 */
@Injectable()
export class BillingCatalogueService {
  constructor(private readonly db: TenantDb) {}

  async plans() {
    return this.db.runPlatform(async (tx) => {
      const plans = await tx.commercialPlan.findMany({
        orderBy: { createdAt: 'asc' },
        include: { versions: { orderBy: { version: 'desc' } } },
      });
      return {
        plans: plans.map((plan) => ({
          id: plan.id,
          code: plan.code,
          name: plan.name,
          description: plan.description,
          audience: plan.audience,
          visibility: plan.visibility,
          status: plan.status,
          versions: plan.versions.map(versionView),
        })),
      };
    });
  }

  async createPlan(actor: ConsoleActor, raw: z.input<typeof commercialPlanInputSchema>) {
    const input = commercialPlanInputSchema.parse(raw);
    return this.db.runPlatform(async (tx) => {
      if ((await tx.commercialPlan.count({ where: { code: input.code } })) > 0) {
        throw invalid('code', 'A plan with this code exists');
      }
      const featurePlan =
        input.featurePlanCode === null
          ? null
          : await tx.plan.findUnique({ where: { code: input.featurePlanCode }, select: { id: true } });
      if (input.featurePlanCode !== null && featurePlan === null) {
        throw invalid('featurePlanCode', 'No feature plan has this code');
      }
      const plan = await tx.commercialPlan.create({
        data: {
          code: input.code,
          name: input.name,
          description: input.description,
          audience: input.audience,
          visibility: input.visibility,
          featurePlanId: featurePlan?.id ?? null,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'commercial_plan.created',
        entityType: 'commercial_plan',
        entityId: plan.id,
        after: input,
      });
      return plan;
    });
  }

  /** A new draft version (numbered after the last). */
  async createVersion(actor: ConsoleActor, planId: string, input: PlanVersionInput) {
    return this.db.runPlatform(async (tx) => {
      const plan = await tx.commercialPlan.findUnique({ where: { id: planId }, select: { status: true } });
      if (plan === null) throw new AppError('NOT_FOUND');
      if (plan.status !== 'ACTIVE') throw new AppError('INVALID_STATE', { detail: 'The plan is archived.' });
      const last = await tx.commercialPlanVersion.findFirst({
        where: { planId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = await tx.commercialPlanVersion.create({
        data: { planId, version: (last?.version ?? 0) + 1, ...versionData(input), createdBy: actor.userId },
      });
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'commercial_plan_version.created',
        entityType: 'commercial_plan_version',
        entityId: version.id,
        after: { planId, version: version.version },
      });
      return versionView(version);
    });
  }

  /** Edits a draft; a published version can't change (the database refuses too). */
  async updateDraft(actor: ConsoleActor, versionId: string, input: PlanVersionInput) {
    return this.db.runPlatform(async (tx) => {
      const current = await tx.commercialPlanVersion.findUnique({ where: { id: versionId } });
      if (current === null) throw new AppError('NOT_FOUND');
      if (current.status !== 'DRAFT') {
        throw new AppError('INVALID_STATE', {
          detail: 'Published versions can’t change; create a new version.',
        });
      }
      const updated = await tx.commercialPlanVersion.update({
        where: { id: versionId },
        data: { ...versionData(input), updatedAt: new Date() },
      });
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'commercial_plan_version.updated',
        entityType: 'commercial_plan_version',
        entityId: versionId,
        before: { components: current.components },
        after: { components: updated.components },
      });
      return versionView(updated);
    });
  }

  async setVersionStatus(actor: ConsoleActor, versionId: string, status: 'PUBLISHED' | 'ARCHIVED') {
    return this.db.runPlatform(async (tx) => {
      const current = await tx.commercialPlanVersion.findUnique({ where: { id: versionId } });
      if (current === null) throw new AppError('NOT_FOUND');
      const allowed = status === 'PUBLISHED' ? current.status === 'DRAFT' : current.status === 'PUBLISHED';
      if (!allowed) {
        throw new AppError('INVALID_STATE', {
          detail: `A ${current.status.toLowerCase()} version can’t be ${status.toLowerCase()}.`,
        });
      }
      const now = new Date();
      const updated = await tx.commercialPlanVersion.update({
        where: { id: versionId },
        data: {
          status,
          ...(status === 'PUBLISHED' && { publishedAt: now, publishedBy: actor.userId }),
          updatedAt: now,
        },
      });
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: `commercial_plan_version.${status.toLowerCase()}`,
        entityType: 'commercial_plan_version',
        entityId: versionId,
        after: { status },
      });
      return versionView(updated);
    });
  }

  // --- Contracts -------------------------------------------------------------------------------------

  async contracts(tenantId: string) {
    return this.db.runPlatform(async (tx) => {
      const rows = await tx.tenantContract.findMany({
        where: { tenantRef: tenantId },
        orderBy: { createdAt: 'desc' },
        include: { planVersion: { include: { plan: { select: { code: true, name: true } } } } },
      });
      return { contracts: rows.map(contractView) };
    });
  }

  /**
   * A draft contract on a published version. Standard contracts may only change the plan's own
   * components; enterprise contracts may add new ones. Add-ons and discounts must name real components.
   */
  async createContract(actor: ConsoleActor, tenantId: string, input: ContractInput) {
    return this.db.runPlatformIn(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { kind: true, currency: true },
      });
      if (tenant === null) throw new AppError('NOT_FOUND');
      const version = await tx.commercialPlanVersion.findUnique({
        where: { id: input.planVersionId },
        include: { plan: true },
      });
      if (version === null || version.status !== 'PUBLISHED') {
        throw invalid('planVersionId', 'Choose a published plan version');
      }
      if (version.plan.audience.length > 0 && !version.plan.audience.includes(tenant.kind)) {
        throw invalid('planVersionId', 'This plan isn’t offered to this kind of school');
      }
      if (version.currency !== tenant.currency) {
        throw invalid(
          'planVersionId',
          `This plan is priced in ${version.currency}; the school uses ${tenant.currency}`,
        );
      }
      const planComponents = storedComponents(version.components);
      const planKeys = new Set(planComponents.map((c) => c.key));
      if (input.kind === 'STANDARD' && input.overrides.some((c) => !planKeys.has(c.key))) {
        throw invalid('overrides', 'Only enterprise contracts can add components');
      }
      for (const override of input.overrides) {
        const original = planComponents.find((c) => c.key === override.key);
        if (original !== undefined && original.type !== override.type) {
          throw invalid('overrides', `${override.key} must stay a ${original.type} component`);
        }
      }
      const merged = mergeComponents(planComponents, input.overrides);
      const addons = new Set(merged.filter((c) => c.type === 'FIXED' && c.optional).map((c) => c.key));
      if (input.enabledAddons.some((key) => !addons.has(key))) {
        throw invalid('enabledAddons', 'Enable only the plan’s optional add-ons');
      }
      const keys = new Set(merged.map((c) => c.key));
      if (input.discounts.some((d) => d.appliesTo.some((key) => !keys.has(key)))) {
        throw invalid('discounts', 'A discount names a component the contract doesn’t have');
      }
      const contract = await tx.tenantContract.create({
        data: {
          tenantRef: tenantId,
          planVersionId: version.id,
          kind: input.kind,
          overrides: input.overrides as object[],
          enabledAddons: input.enabledAddons,
          discounts: input.discounts as object[],
          billingAnchorDay: input.billingAnchorDay,
          activationPolicy: input.activationPolicy,
          startsOn: new Date(`${input.startsOn}T00:00:00Z`),
          endsOn: input.endsOn === null ? null : new Date(`${input.endsOn}T00:00:00Z`),
          note: input.note,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      const entry = {
        actorId: actor.userId,
        action: 'contract.created',
        entityType: 'tenant_contract',
        entityId: contract.id,
        tenantRef: tenantId,
        after: {
          planVersionId: version.id,
          kind: input.kind,
          startsOn: input.startsOn,
          discounts: input.discounts.length,
        },
      };
      await recordPlatform(tx, entry);
      await recordInSchool(tx, tenantId, entry);
      return contract;
    });
  }

  /** Activates a draft; the school's current contract (if any) ends the day the new one starts. */
  async activateContract(actor: ConsoleActor, contractId: string) {
    const found = await this.db.runPlatform((tx) =>
      tx.tenantContract.findUnique({ where: { id: contractId }, select: { tenantRef: true } }),
    );
    if (found === null) throw new AppError('NOT_FOUND');
    await this.db.runPlatformIn(found.tenantRef, (tx) => activateContractTx(tx, actor, contractId));
  }
}

/**
 * Activates a draft contract in the caller's platform transaction (scoped to its school): the current
 * active contract ends the day the new one starts. Returns the contract that ended, if any.
 */
export async function activateContractTx(
  tx: TenantTx,
  actor: { userId: string | null },
  contractId: string,
): Promise<{ endedContractId: string | null }> {
  const [contract] = await tx.$queryRaw<
    { id: string; status: string; starts_on: Date; tenant_ref: string }[]
  >`
    SELECT id, status, starts_on, tenant_ref FROM tenant_contract WHERE id = ${contractId}::uuid FOR UPDATE`;
  if (contract?.status !== 'DRAFT') {
    throw new AppError('INVALID_STATE', { detail: 'Only a draft contract can be activated.' });
  }
  const current = await tx.tenantContract.findFirst({
    where: { tenantRef: contract.tenant_ref, status: 'ACTIVE' },
  });
  const now = new Date();
  if (current !== null) {
    if (contract.starts_on <= current.startsOn) {
      throw new AppError('INVALID_STATE', {
        detail: 'The new contract must start after the current one started.',
      });
    }
    await tx.tenantContract.update({
      where: { id: current.id },
      data: {
        status: 'ENDED',
        endsOn:
          current.endsOn !== null && current.endsOn < contract.starts_on
            ? current.endsOn
            : contract.starts_on,
        endedAt: now,
        updatedAt: now,
      },
    });
  }
  await tx.tenantContract.update({
    where: { id: contractId },
    data: { status: 'ACTIVE', activatedAt: now, updatedAt: now },
  });
  const entry = {
    actorId: actor.userId,
    action: 'contract.activated',
    entityType: 'tenant_contract',
    entityId: contractId,
    tenantRef: contract.tenant_ref,
    ...(current !== null && { before: { contractId: current.id } }),
    after: { contractId },
  };
  await recordPlatform(tx, entry);
  await recordInSchool(tx, contract.tenant_ref, entry);
  return { endedContractId: current?.id ?? null };
}

function versionData(input: PlanVersionInput) {
  return {
    currency: input.currency,
    billingCycle: input.billingCycle,
    trialDays: input.trialDays,
    graceDays: input.graceDays,
    paymentTermsDays: input.paymentTermsDays,
    components: input.components as object[],
    allowedPaymentModes: input.allowedPaymentModes,
    notes: input.notes,
  };
}

const dateOnly = (value: Date) => value.toISOString().slice(0, 10);

export function versionView(v: {
  id: string;
  version: number;
  status: string;
  currency: string;
  billingCycle: string;
  trialDays: number;
  graceDays: number;
  paymentTermsDays: number;
  components: unknown;
  allowedPaymentModes: string[];
  notes: string;
  publishedAt: Date | null;
}) {
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    currency: v.currency,
    billingCycle: v.billingCycle,
    trialDays: v.trialDays,
    graceDays: v.graceDays,
    paymentTermsDays: v.paymentTermsDays,
    components: v.components,
    allowedPaymentModes: v.allowedPaymentModes,
    notes: v.notes,
    publishedAt: v.publishedAt?.toISOString() ?? null,
  };
}

function contractView(c: {
  id: string;
  tenantRef: string;
  kind: string;
  status: string;
  overrides: unknown;
  enabledAddons: string[];
  discounts: unknown;
  billingAnchorDay: number;
  startsOn: Date;
  endsOn: Date | null;
  note: string;
  planVersion: { id: string; version: number; plan: { code: string; name: string } };
}) {
  return {
    id: c.id,
    tenantId: c.tenantRef,
    kind: c.kind,
    status: c.status,
    plan: { code: c.planVersion.plan.code, name: c.planVersion.plan.name },
    planVersion: { id: c.planVersion.id, version: c.planVersion.version },
    overrides: c.overrides,
    enabledAddons: c.enabledAddons,
    discounts: c.discounts,
    billingAnchorDay: c.billingAnchorDay,
    startsOn: dateOnly(c.startsOn),
    endsOn: c.endsOn === null ? null : dateOnly(c.endsOn),
    note: c.note,
  };
}
