import { Injectable } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

import type { PrismaClient } from '../../../generated/prisma/client';
import { recordInSchool, recordPlatform } from '../../console';
import {
  AppError,
  enqueue,
  type JobEnvelope,
  requireTenantId,
  runInPlatformTenantTx,
  runInPlatformTx,
  SecretBox,
  TenantDb,
  type TenantTx,
} from '../../platform';
import type { JournalDraft } from '../domain/ledger';
import { clip, type Cycle, cycleContaining } from '../domain/periods';
import { canTransition, dunningPath, type SubscriptionStatus } from '../domain/subscription-rules';
import { activateContractTx } from './catalogue.service';
import { addDays, type BillingActor, dateOnly, day, draftInvoice, issueInvoice, SYSTEM } from './invoices';
import { postJournal } from './ledger-poster';
import { notifyOwners } from './notices';

export const BILLING_CYCLE_JOB = 'billing.cycle';
/** The most periods one cycle bills for a school (a long outage catches up over several runs). */
const MAX_PERIODS_PER_RUN = 24;

type Deps = { box: SecretBox };

const P2002 = 'P2002';

/** The school's latest subscription (live or cancelled), locked for this transaction. */
async function lockSubscription(tx: TenantTx, tenantId: string) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM tenant_subscription WHERE tenant_ref = ${tenantId}::uuid
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
  if (row === undefined) return null;
  return tx.tenantSubscription.findUniqueOrThrow({
    where: { id: row.id },
    include: { contract: { include: { planVersion: { include: { plan: true } } } } },
  });
}

async function record(
  tx: TenantTx,
  actor: BillingActor,
  subscription: { id: string; tenantRef: string },
  kind: string,
  transition: { from?: SubscriptionStatus; to?: SubscriptionStatus },
  detail: Record<string, unknown> = {},
): Promise<void> {
  await tx.subscriptionEvent.create({
    data: {
      subscriptionId: subscription.id,
      tenantRef: subscription.tenantRef,
      kind,
      fromStatus: transition.from ?? null,
      toStatus: transition.to ?? null,
      detail: detail as object,
      actorId: actor.userId,
    },
  });
  const entry = {
    actorId: actor.userId,
    action: `subscription.${kind.toLowerCase()}`,
    entityType: 'tenant_subscription',
    entityId: subscription.id,
    tenantRef: subscription.tenantRef,
    after: { ...detail, ...(transition.to !== undefined && { status: transition.to }) },
  };
  await recordPlatform(tx, entry);
  await recordInSchool(tx, subscription.tenantRef, entry);
}

/** The plan's features and limits apply to the school (the existing feature/limit engine, BR-48/49). */
async function applyEntitlements(
  tx: TenantTx,
  tenantId: string,
  featurePlanId: string | null,
): Promise<void> {
  if (featurePlanId === null) return;
  await tx.tenant.update({
    where: { id: tenantId },
    data: { planId: featurePlanId, updatedAt: new Date(), version: { increment: 1 } },
  });
}

/**
 * Starts billing a school on its active contract: trialing when the plan has a trial, else active.
 * With AFTER_SETUP_PAYMENT, the one-time charges are invoiced now and the school can go live once paid.
 */
export async function startSubscription(
  tx: TenantTx,
  deps: Deps,
  actor: BillingActor,
  tenantId: string,
  now = new Date(),
) {
  const live = await tx.tenantSubscription.findFirst({
    where: { tenantRef: tenantId, status: { not: 'CANCELLED' } },
    select: { id: true },
  });
  if (live !== null)
    throw new AppError('INVALID_STATE', { detail: 'The school already has a subscription.' });
  const contract = await tx.tenantContract.findFirst({
    where: { tenantRef: tenantId, status: 'ACTIVE' },
    include: { planVersion: { include: { plan: true } } },
  });
  if (contract === null) {
    throw new AppError('INVALID_STATE', { detail: 'Activate a contract for the school first.' });
  }
  const trialDays = contract.planVersion.trialDays;
  const startsOn = dateOnly(contract.startsOn);
  const status: SubscriptionStatus = trialDays > 0 ? 'TRIALING' : 'ACTIVE';
  const subscription = await tx.tenantSubscription.create({
    data: {
      tenantRef: tenantId,
      contractId: contract.id,
      status,
      trialEndsOn: trialDays > 0 ? day(addDays(startsOn, trialDays)) : null,
      billedThrough: contract.startsOn,
      createdBy: actor.userId,
    },
  });
  await record(
    tx,
    actor,
    subscription,
    'STARTED',
    { to: status },
    {
      contractId: contract.id,
      plan: contract.planVersion.plan.code,
      version: contract.planVersion.version,
    },
  );
  await applyEntitlements(tx, tenantId, contract.planVersion.plan.featurePlanId);
  if (contract.activationPolicy === 'AFTER_SETUP_PAYMENT') {
    const invoiceId = await draftInvoice(tx, actor, tenantId, { forDate: startsOn, kind: 'SETUP', now });
    await issueInvoice(tx, deps, actor, invoiceId, now);
    const issued = await tx.saasInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { status: true },
    });
    // Nothing to pay (no one-time charges): the school may go live straight away.
    if (issued.status === 'PAID') {
      await tx.tenantSubscription.update({ where: { id: subscription.id }, data: { setupPaidAt: now } });
    }
  }
  return subscription.id;
}

/**
 * Records a payment received outside the payment provider (bank transfer, cash) against an issued
 * invoice: once per reference, never more than is owed, posted to the ledger. A fully paid invoice is
 * marked paid exactly once; then the setup gate lifts and dunning re-evaluates (it may reactivate).
 */
export async function recordPayment(
  tx: TenantTx,
  deps: Deps,
  actor: BillingActor,
  invoiceId: string,
  input: {
    amountMinor: number;
    method: 'BANK_TRANSFER' | 'CASH' | 'OTHER';
    reference: string;
    receivedOn: string;
    note: string;
  },
  now = new Date(),
): Promise<void> {
  const [invoice] = await tx.$queryRaw<
    {
      status: string;
      tenant_ref: string;
      total_minor: bigint;
      amount_paid_minor: bigint;
      currency: string;
      kind: string;
      number: string | null;
      due_at: Date | null;
    }[]
  >`SELECT status, tenant_ref, total_minor, amount_paid_minor, currency, kind::text AS kind, number, due_at
      FROM saas_invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;
  if (invoice === undefined) throw new AppError('NOT_FOUND');
  if (invoice.status !== 'ISSUED') {
    throw new AppError('INVALID_STATE', { detail: 'Payments are recorded against issued, unpaid invoices.' });
  }
  const amount = BigInt(input.amountMinor);
  const owed = invoice.total_minor - invoice.amount_paid_minor;
  if (amount > owed) {
    throw new AppError('VALIDATION_FAILED', {
      errors: [
        { field: 'amountMinor', code: 'too_much', message: `At most ${owed} is owed on this invoice` },
      ],
    });
  }
  let payment;
  try {
    payment = await tx.saasPayment.create({
      data: {
        invoiceId,
        tenantRef: invoice.tenant_ref,
        amountMinor: amount,
        currency: invoice.currency,
        method: input.method,
        reference: input.reference,
        receivedOn: day(input.receivedOn),
        note: input.note,
        recordedBy: actor.userId,
      },
      select: { id: true },
    });
  } catch (error) {
    if ((error as { code?: string }).code === P2002) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [
          { field: 'reference', code: 'duplicate', message: 'This payment reference is already recorded' },
        ],
      });
    }
    throw error;
  }
  const paidInFull = amount === owed;
  await tx.saasInvoice.update({
    where: { id: invoiceId },
    data: {
      amountPaidMinor: invoice.amount_paid_minor + amount,
      ...(paidInFull && { status: 'PAID', paidAt: now }),
      updatedAt: now,
    },
  });
  const journal: JournalDraft = {
    kind: 'SAAS_PAYMENT_RECEIVED',
    description: `Payment ${input.reference} for invoice ${invoice.number ?? invoiceId}`,
    currency: invoice.currency,
    sourceType: 'saas_payment',
    sourceId: payment.id,
    lines: [
      {
        account: 'cash.bank',
        tenantRef: invoice.tenant_ref,
        debitMinor: amount,
        creditMinor: 0n,
        memo: input.reference,
      },
      {
        account: 'receivable.saas',
        tenantRef: invoice.tenant_ref,
        debitMinor: 0n,
        creditMinor: amount,
        memo: input.reference,
      },
    ],
  };
  await postJournal(tx, journal, { actorId: actor.userId });
  const entry = {
    actorId: actor.userId,
    action: 'saas_invoice.payment_recorded',
    entityType: 'saas_invoice',
    entityId: invoiceId,
    tenantRef: invoice.tenant_ref,
    after: { amountMinor: amount.toString(), method: input.method, reference: input.reference, paidInFull },
  };
  await recordPlatform(tx, entry);
  await recordInSchool(tx, invoice.tenant_ref, entry);
  if (!paidInFull) return;
  await notifyOwners(tx, deps.box, invoice.tenant_ref, invoice.kind === 'SETUP' ? 'SETUP_PAID' : 'PAID', {
    number: invoice.number,
    amountMinor: invoice.total_minor,
    currency: invoice.currency,
    dueAt: invoice.due_at,
  });
  const subscription = await lockSubscription(tx, invoice.tenant_ref);
  if (subscription === null) return;
  if (invoice.kind === 'SETUP' && subscription.setupPaidAt === null) {
    await tx.tenantSubscription.update({
      where: { id: subscription.id },
      data: { setupPaidAt: now, updatedAt: now },
    });
    await record(tx, actor, subscription, 'SETUP_PAID', {}, { invoiceId });
  }
  await applyDunning(tx, deps, actor, invoice.tenant_ref, now);
}

/** Moves the subscription along the path the school's unpaid invoices call for (see dunningPath). */
export async function applyDunning(
  tx: TenantTx,
  deps: Deps,
  actor: BillingActor,
  tenantId: string,
  now: Date,
) {
  const subscription = await lockSubscription(tx, tenantId);
  if (subscription === null || subscription.status === 'CANCELLED') return;
  const unpaid = await tx.saasInvoice.findMany({
    where: { tenantRef: tenantId, status: 'ISSUED', dueAt: { not: null } },
    select: { number: true, dueAt: true, totalMinor: true, amountPaidMinor: true, currency: true },
    orderBy: { dueAt: 'asc' },
  });
  let status = subscription.status as SubscriptionStatus;
  const path = dunningPath({
    status,
    unpaid: unpaid.map((invoice) => ({ dueAt: invoice.dueAt! })),
    graceDays: subscription.contract.planVersion.graceDays,
    now,
  });
  for (const next of path) {
    if (!canTransition(status, next)) break;
    const oldest = unpaid[0];
    if (next === 'PAST_DUE') {
      await tx.tenantSubscription.update({
        where: { id: subscription.id },
        data: { status: next, pastDueSince: subscription.pastDueSince ?? now, updatedAt: now },
      });
    } else if (next === 'SUSPENDED') {
      // Only a live school is suspended; one not yet live stays as it is (it can't go live unpaid anyway).
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true } });
      const suspendSchool = tenant.status === 'ACTIVE';
      if (suspendSchool) {
        await tx.tenant.update({
          where: { id: tenantId },
          data: {
            status: 'SUSPENDED',
            suspendedReason: `Billing: invoice ${oldest?.number ?? ''} is overdue`,
            updatedAt: now,
            version: { increment: 1 },
          },
        });
      }
      await tx.tenantSubscription.update({
        where: { id: subscription.id },
        data: { status: next, suspendedAt: now, suspendedForBilling: suspendSchool, updatedAt: now },
      });
      if (oldest !== undefined) {
        await notifyOwners(tx, deps.box, tenantId, 'SUSPENDED', {
          number: oldest.number,
          amountMinor: oldest.totalMinor - oldest.amountPaidMinor,
          currency: oldest.currency,
          dueAt: oldest.dueAt,
        });
      }
    } else if (next === 'ACTIVE') {
      // Lift only a suspension billing made; one made by staff stays (and the subscription says so).
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true } });
      const reactivate = subscription.suspendedForBilling && tenant.status === 'SUSPENDED';
      if (reactivate) {
        await tx.tenant.update({
          where: { id: tenantId },
          data: { status: 'ACTIVE', suspendedReason: null, updatedAt: now, version: { increment: 1 } },
        });
      }
      await tx.tenantSubscription.update({
        where: { id: subscription.id },
        data: {
          status: next,
          pastDueSince: null,
          suspendedAt: null,
          suspendedForBilling: false,
          updatedAt: now,
        },
      });
      if (status === 'SUSPENDED') {
        await notifyOwners(tx, deps.box, tenantId, 'REACTIVATED', {
          number: null,
          amountMinor: 0n,
          currency: subscription.contract.planVersion.currency,
          dueAt: null,
        });
      }
    }
    await record(
      tx,
      actor,
      subscription,
      'STATUS_CHANGED',
      { from: status, to: next },
      {
        ...(oldest !== undefined && next !== 'ACTIVE' && { invoice: oldest.number }),
      },
    );
    status = next;
  }
}

/**
 * Cancels the subscription. At period end: billing stops after the current period. Now: the contract
 * ends today and the final partial period is billed. School data is never deleted.
 */
export async function cancelSubscription(
  tx: TenantTx,
  actor: BillingActor,
  tenantId: string,
  input: { atPeriodEnd: boolean; reason: string },
  now = new Date(),
) {
  const subscription = await lockSubscription(tx, tenantId);
  if (subscription === null || subscription.status === 'CANCELLED') {
    throw new AppError('INVALID_STATE', { detail: 'The school has no live subscription.' });
  }
  if (input.atPeriodEnd) {
    await tx.tenantSubscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true, cancelReason: input.reason, updatedAt: now },
    });
    await record(tx, actor, subscription, 'CANCEL_SCHEDULED', {}, { reason: input.reason });
    return;
  }
  await endSubscription(tx, actor, subscription, dateOnly(now), input.reason, now);
}

async function endSubscription(
  tx: TenantTx,
  actor: BillingActor,
  subscription: NonNullable<Awaited<ReturnType<typeof lockSubscription>>>,
  endOn: string,
  reason: string,
  now: Date,
) {
  const contract = subscription.contract;
  if (contract.status === 'ACTIVE') {
    const startsOn = dateOnly(contract.startsOn);
    const end = endOn > startsOn ? endOn : addDays(startsOn, 1);
    await tx.tenantContract.update({
      where: { id: contract.id },
      data: { status: 'ENDED', endsOn: day(end), endedAt: now, updatedAt: now },
    });
  }
  await tx.tenantSubscription.update({
    where: { id: subscription.id },
    data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, updatedAt: now },
  });
  await record(
    tx,
    actor,
    subscription,
    'CANCELLED',
    { from: subscription.status as SubscriptionStatus, to: 'CANCELLED' },
    { reason },
  );
}

/**
 * Upgrades and downgrades: the new (draft) contract starts on the change date; the current contract ends
 * that day, so each side's period is billed in proportion. The new plan's features apply at once.
 */
export async function changePlan(tx: TenantTx, actor: BillingActor, tenantId: string, contractId: string) {
  const subscription = await lockSubscription(tx, tenantId);
  if (subscription === null || subscription.status === 'CANCELLED') {
    throw new AppError('INVALID_STATE', { detail: 'The school has no live subscription.' });
  }
  const next = await tx.tenantContract.findFirst({
    where: { id: contractId, tenantRef: tenantId, status: 'DRAFT' },
    include: { planVersion: { include: { plan: true } } },
  });
  if (next === null)
    throw new AppError('INVALID_STATE', { detail: 'Choose a draft contract of this school.' });
  if (next.startsOn < subscription.billedThrough) {
    throw new AppError('INVALID_STATE', {
      detail: 'A plan change can’t start in a period already invoiced.',
    });
  }
  await activateContractTx(tx, actor, contractId);
  await tx.tenantSubscription.update({
    where: { id: subscription.id },
    data: { contractId, updatedAt: new Date() },
  });
  await applyEntitlements(tx, tenantId, next.planVersion.plan.featurePlanId);
  await record(
    tx,
    actor,
    subscription,
    'PLAN_CHANGED',
    {},
    {
      from: subscription.contract.planVersion.plan.code,
      to: next.planVersion.plan.code,
      effectiveOn: dateOnly(next.startsOn),
    },
  );
}

/**
 * The billing cycle of one school (worker job `billing.cycle`, also run from the console):
 * invoices every contract period that has ended since `billed_through` (in arrears), ends the trial,
 * applies a scheduled cancellation, then dunning. Safe to run any number of times.
 */
export async function runBillingCycle(tx: TenantTx, deps: Deps, tenantId: string, now = new Date()) {
  const subscription = await lockSubscription(tx, tenantId);
  if (subscription === null) return { invoiced: 0 };
  const today = dateOnly(now);
  let cursor = dateOnly(subscription.billedThrough);
  let invoiced = 0;
  for (let i = 0; i < MAX_PERIODS_PER_RUN; i += 1) {
    const contract = await tx.tenantContract.findFirst({
      where: {
        tenantRef: tenantId,
        status: { in: ['ACTIVE', 'ENDED'] },
        startsOn: { lte: day(cursor) },
        OR: [{ endsOn: null }, { endsOn: { gt: day(cursor) } }],
      },
      orderBy: { startsOn: 'desc' },
      include: { planVersion: { select: { billingCycle: true } } },
    });
    if (contract === null) break;
    const cycle = cycleContaining(
      cursor,
      contract.planVersion.billingCycle as Cycle,
      contract.billingAnchorDay,
      dateOnly(contract.startsOn),
    );
    const period = clip(cycle, cursor, contract.endsOn === null ? null : dateOnly(contract.endsOn));
    if (period === null || period.end > today) break;
    const already = await tx.saasInvoice.findFirst({
      where: {
        contractId: contract.id,
        kind: 'RECURRING',
        periodStart: day(period.start),
        status: { not: 'VOID' },
      },
      select: { id: true },
    });
    if (already === null) {
      const invoiceId = await draftInvoice(tx, SYSTEM, tenantId, { forDate: cursor, now });
      await issueInvoice(tx, deps, SYSTEM, invoiceId, now);
      invoiced += 1;
    }
    cursor = period.end;
    await tx.tenantSubscription.update({
      where: { id: subscription.id },
      data: { billedThrough: day(cursor), updatedAt: now },
    });
    // A scheduled cancellation ends billing at the end of the current period.
    if (subscription.cancelAtPeriodEnd && subscription.status !== 'CANCELLED') {
      const fresh = await lockSubscription(tx, tenantId);
      await endSubscription(
        tx,
        SYSTEM,
        fresh!,
        cursor,
        subscription.cancelReason ?? 'Cancelled at period end',
        now,
      );
      break;
    }
  }
  const current = await lockSubscription(tx, tenantId);
  if (
    current !== null &&
    current.status === 'TRIALING' &&
    current.trialEndsOn !== null &&
    today >= dateOnly(current.trialEndsOn)
  ) {
    await tx.tenantSubscription.update({
      where: { id: current.id },
      data: { status: 'ACTIVE', updatedAt: now },
    });
    await record(tx, SYSTEM, current, 'TRIAL_ENDED', { from: 'TRIALING', to: 'ACTIVE' });
  }
  await applyDunning(tx, deps, SYSTEM, tenantId, now);
  return { invoiced };
}

/** Worker job `billing.cycle`, one per school with a subscription. */
export function createBillingCycleHandler(deps: { prisma: PrismaClient; box: SecretBox }) {
  return async (_envelope: JobEnvelope, logger: Logger) => {
    const tenantId = requireTenantId();
    const result = await runInPlatformTenantTx(deps.prisma, tenantId, (tx) =>
      runBillingCycle(tx, { box: deps.box }, tenantId),
    );
    logger.info(result, 'Billing cycle');
    return result;
  };
}

/** Hourly sweep: one billing-cycle job per school with a live subscription (or a final period to bill). */
export async function sweepBilling(deps: { prisma: PrismaClient; boss: PgBoss }): Promise<number> {
  const tenants = await runInPlatformTx(deps.prisma, (tx) =>
    tx.tenantSubscription.findMany({
      where: {
        OR: [
          { status: { not: 'CANCELLED' } },
          { cancelledAt: { gt: new Date(Date.now() - 400 * 86_400_000) } },
        ],
      },
      distinct: ['tenantRef'],
      select: { tenantRef: true },
    }),
  );
  for (const { tenantRef } of tenants) {
    await enqueue(deps.boss, BILLING_CYCLE_JOB, {}, { tenantId: tenantRef });
  }
  return tenants.length;
}

/** Subscriptions in the console (start, cancel, change plan, payments, run the cycle now, history). */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly db: TenantDb,
    private readonly box: SecretBox,
  ) {}

  view(tenantId: string) {
    return this.db.runPlatform(async (tx) => {
      const subscription = await tx.tenantSubscription.findFirst({
        where: { tenantRef: tenantId },
        orderBy: { createdAt: 'desc' },
        include: {
          contract: {
            include: { planVersion: { include: { plan: { select: { code: true, name: true } } } } },
          },
          events: { orderBy: { at: 'asc' } },
        },
      });
      if (subscription === null) return { subscription: null };
      return {
        subscription: {
          id: subscription.id,
          status: subscription.status,
          plan: subscription.contract.planVersion.plan,
          contractId: subscription.contractId,
          activationPolicy: subscription.contract.activationPolicy,
          trialEndsOn: subscription.trialEndsOn === null ? null : dateOnly(subscription.trialEndsOn),
          billedThrough: dateOnly(subscription.billedThrough),
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          setupPaidAt: subscription.setupPaidAt?.toISOString() ?? null,
          pastDueSince: subscription.pastDueSince?.toISOString() ?? null,
          suspendedAt: subscription.suspendedAt?.toISOString() ?? null,
          cancelledAt: subscription.cancelledAt?.toISOString() ?? null,
          events: subscription.events.map((e) => ({
            kind: e.kind,
            from: e.fromStatus,
            to: e.toStatus,
            detail: e.detail,
            at: e.at.toISOString(),
          })),
        },
      };
    });
  }

  async start(actor: BillingActor, tenantId: string) {
    await this.db.runPlatformIn(tenantId, (tx) => startSubscription(tx, { box: this.box }, actor, tenantId));
    return this.view(tenantId);
  }

  async cancel(actor: BillingActor, tenantId: string, input: { atPeriodEnd: boolean; reason: string }) {
    await this.db.runPlatformIn(tenantId, (tx) => cancelSubscription(tx, actor, tenantId, input));
    return this.view(tenantId);
  }

  async changePlan(actor: BillingActor, tenantId: string, contractId: string) {
    await this.db.runPlatformIn(tenantId, (tx) => changePlan(tx, actor, tenantId, contractId));
    return this.view(tenantId);
  }

  async recordPayment(
    actor: BillingActor,
    tenantId: string,
    invoiceId: string,
    input: Parameters<typeof recordPayment>[4],
  ) {
    await this.db.runPlatformIn(tenantId, (tx) =>
      recordPayment(tx, { box: this.box }, actor, invoiceId, input),
    );
  }

  runCycle(tenantId: string) {
    return this.db.runPlatformIn(tenantId, (tx) => runBillingCycle(tx, { box: this.box }, tenantId));
  }
}
