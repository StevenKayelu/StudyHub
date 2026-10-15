import { Inject, Injectable } from '@nestjs/common';
import {
  detectNetwork,
  maskMsisdn,
  type MyEarnings,
  normalizeMsisdn,
  type payoutMethodInputSchema,
} from '@studyhub/contracts';
import type { z } from 'zod';

import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import {
  AppError,
  queueEmail,
  requireTenantId,
  SecretBox,
  ConfigService,
  TenantDb,
  type TenantTx,
} from '../../platform';
import { readCommerceSettings, requireFeature } from '../../tenancy';
import { balances, checkPayout, formatAmount } from '../domain/money-rules';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../infra/payment-gateway';
import { ledgerLines } from './admin-orders.service';
import { buyerOf, schoolLink, schoolName } from './settlement';

type PayoutMethodInput = z.infer<typeof payoutMethodInputSchema>;

/**
 * Instructor earnings and payouts (F29, W3; S-T11, S-T12, S-AD05). Only with `instructorRevenueShare`:
 * while it is off these answer 403 FEATURE_NOT_ENABLED and the data stays (F40).
 */
@Injectable()
export class EarningsService {
  constructor(
    private readonly db: TenantDb,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly box: SecretBox,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  // --- Administration (S-AD05) -----------------------------------------------------------------

  async instructors(actor: TenantActor) {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      await requireFeature(tx, 'instructorRevenueShare');
      const entries = await tx.ledgerEntry.findMany({
        select: {
          instructorMembershipId: true,
          status: true,
          netMinor: true,
          availableAt: true,
          currency: true,
        },
      });
      const ids = [...new Set(entries.map((e) => e.instructorMembershipId))];
      const names = await namesOf(tx, ids);
      const hints = await defaultHints(tx, ids);
      const now = new Date();
      return {
        instructors: ids
          .map((id) => {
            const own = entries.filter((e) => e.instructorMembershipId === id);
            const total = balances(
              own.map((e) => ({
                status: e.status,
                netMinor: Number(e.netMinor),
                availableAt: e.availableAt,
              })),
              now,
              new Date(0),
            );
            return {
              membershipId: id,
              name: names.get(id) ?? '',
              pending: total.pending,
              available: total.available,
              paid: total.paid,
              currency: own[0]?.currency ?? 'ZMW',
              payoutMethodHint: hints.get(id) ?? null,
            };
          })
          .sort((a, b) => b.available - a.available || a.name.localeCompare(b.name)),
      };
    });
  }

  /** One instructor's entries, for choosing what a payout covers. */
  async instructorLedger(actor: TenantActor, membershipId: string) {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      await requireFeature(tx, 'instructorRevenueShare');
      await releaseDue(tx, membershipId);
      const names = await namesOf(tx, [membershipId]);
      const hints = await defaultHints(tx, [membershipId]);
      const entries = await ledgerLines(tx, { instructorMembershipId: membershipId });
      if (entries.length === 0 && !names.has(membershipId)) throw new AppError('NOT_FOUND');
      return {
        name: names.get(membershipId) ?? '',
        entries,
        payoutMethodHint: hints.get(membershipId) ?? null,
      };
    });
  }

  /** POST /admin/payouts (W3): records money paid outside StudyHub; entries become PAID. */
  async recordPayout(
    actor: TenantActor,
    input: {
      membershipId: string;
      entryIds: string[];
      externalReference: string;
      paidAt: string;
      note?: string | undefined;
    },
  ) {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      await requireFeature(tx, 'instructorRevenueShare');
      await tx.$queryRaw`SELECT id FROM ledger_entry WHERE instructor_membership_id = ${input.membershipId}::uuid FOR UPDATE`;
      await releaseDue(tx, input.membershipId);
      const available = await tx.ledgerEntry.findMany({
        where: { instructorMembershipId: input.membershipId, status: 'AVAILABLE' },
        select: { id: true, status: true, netMinor: true, availableAt: true, currency: true },
      });
      const check = checkPayout(
        input.entryIds,
        available.map((e) => ({
          id: e.id,
          status: e.status,
          netMinor: Number(e.netMinor),
          availableAt: e.availableAt,
        })),
      );
      if (!check.ok) {
        const message = {
          UNKNOWN_ENTRY: 'An entry is not one of this instructor’s available earnings.',
          NOT_AVAILABLE: 'An entry is not available yet.',
          NEGATIVE_LEFT_OUT: 'Include every refund reversal (negative entry) in this payout.',
          NOT_POSITIVE: 'The payout total must be more than zero.',
        }[check.problem.code];
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'entryIds', code: check.problem.code, message }],
        });
      }
      const method = await tx.payoutMethod.findFirst({
        where: { membershipId: input.membershipId, isDefault: true },
        select: { type: true, displayHint: true },
      });
      const currency = available[0]?.currency ?? 'ZMW';
      const payout = await tx.payout.create({
        data: {
          tenantId: requireTenantId(),
          instructorMembershipId: input.membershipId,
          amountMinor: BigInt(check.totalMinor),
          currency,
          ...(method !== null && { methodSnapshot: { type: method.type, hint: method.displayHint } }),
          externalReference: input.externalReference,
          paidAt: new Date(`${input.paidAt}T12:00:00Z`),
          recordedBy: actor.membershipId,
          note: input.note ?? null,
        },
        select: { id: true },
      });
      const updated = await tx.ledgerEntry.updateMany({
        where: {
          id: { in: [...new Set(input.entryIds)] },
          instructorMembershipId: input.membershipId,
          status: 'AVAILABLE',
        },
        data: { status: 'PAID', payoutId: payout.id, updatedAt: new Date() },
      });
      // 05 §3.7: the amount equals the sum of the linked entries, verified in this transaction.
      const linked = await tx.ledgerEntry.aggregate({
        where: { payoutId: payout.id },
        _sum: { netMinor: true },
      });
      if (
        updated.count !== new Set(input.entryIds).size ||
        Number(linked._sum.netMinor ?? 0n) !== check.totalMinor
      ) {
        throw new AppError('VERSION_CONFLICT');
      }
      const instructor = await buyerOf(tx, input.membershipId);
      if (instructor !== null) {
        await queueEmail(tx, this.box, {
          template: 'payout-recorded',
          to: instructor.email,
          vars: {
            schoolName: await schoolName(tx),
            displayName: instructor.name,
            amount: formatAmount(check.totalMinor, currency),
            reference: input.externalReference,
            link: await schoolLink(tx, this.config.get('SCHOOL_URL_TEMPLATE'), '/studio/earnings'),
          },
        });
      }
      await this.audit.record(tx, {
        action: 'payout.recorded',
        entityType: 'payout',
        entityId: payout.id,
        actorId: actor.userId,
        after: {
          membershipId: input.membershipId,
          amountMinor: check.totalMinor,
          entries: input.entryIds.length,
          externalReference: input.externalReference,
        },
      });
      return { payoutId: payout.id, amount: { amountMinor: check.totalMinor, currency } };
    });
  }

  async payouts(actor: TenantActor) {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      await requireFeature(tx, 'instructorRevenueShare');
      return { payouts: await payoutViews(tx, {}) };
    });
  }

  // --- Instructor (S-T11, S-T12) ----------------------------------------------------------------

  async mine(actor: TenantActor): Promise<MyEarnings> {
    requireInstructor(actor);
    return this.db.run(async (tx) => {
      await requireFeature(tx, 'instructorRevenueShare');
      await releaseDue(tx, actor.membershipId);
      const settings = await readCommerceSettings(tx);
      const entries = await ledgerLines(tx, { instructorMembershipId: actor.membershipId });
      const payouts = await payoutViews(tx, { instructorMembershipId: actor.membershipId });
      const paidAt = new Map(payouts.map((p) => [p.id, new Date(p.paidAt)]));
      const now = new Date();
      const total = balances(
        entries.map((e) => ({
          status: e.status,
          netMinor: e.net,
          availableAt: new Date(e.availableAt),
          paidAt: e.payoutId === null ? null : (paidAt.get(e.payoutId) ?? null),
        })),
        now,
        new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
      );
      const months = new Map<string, MyEarnings['months'][number]>();
      for (const entry of [...entries].reverse()) {
        const month = entry.createdAt.slice(0, 7);
        const bucket = months.get(month) ?? { month, gross: 0, fees: 0, commission: 0, net: 0, entries: [] };
        bucket.gross += entry.gross;
        bucket.fees += entry.providerFee;
        bucket.commission += entry.commission;
        bucket.net += entry.net;
        bucket.entries.push(entry);
        months.set(month, bucket);
      }
      return {
        currency: entries[0]?.currency ?? 'ZMW',
        balances: { pending: total.pending, available: total.available, paidThisYear: total.paidThisYear },
        months: [...months.values()],
        payouts,
        refundWindowDays: settings.refundWindowDays,
        commissionBps: settings.instructorCommissionBps,
        payoutSchedule: settings.payoutSchedule,
      };
    });
  }

  /** S-T11 CSV export of the instructor's own statement. */
  async mineCsv(actor: TenantActor): Promise<string> {
    const earnings = await this.mine(actor);
    const lines = ['date,type,course,status,gross,fee,commission,net,currency'];
    for (const month of earnings.months) {
      for (const e of month.entries) {
        lines.push(
          [
            e.createdAt.slice(0, 10),
            e.type,
            csv(e.courseTitle),
            e.status,
            e.gross,
            e.providerFee,
            e.commission,
            e.net,
            e.currency,
          ]
            .map((value) => (typeof value === 'number' ? (value / 100).toFixed(2) : value))
            .join(','),
        );
      }
    }
    return `${lines.join('\n')}\n`;
  }

  async payoutMethods(actor: TenantActor) {
    requireInstructor(actor);
    return this.db.run(async (tx) => ({
      methods: (
        await tx.payoutMethod.findMany({
          where: { membershipId: actor.membershipId },
          orderBy: { createdAt: 'asc' },
          select: { id: true, type: true, displayHint: true, isDefault: true, createdAt: true },
        })
      ).map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    }));
  }

  async addPayoutMethod(actor: TenantActor, input: PayoutMethodInput) {
    requireInstructor(actor);
    let hint: string;
    if (input.type === 'MOBILE_MONEY') {
      const msisdn = normalizeMsisdn(input.msisdn);
      const network = msisdn === null ? null : detectNetwork(msisdn);
      if (msisdn === null || network === null) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [
            {
              field: 'msisdn',
              code: 'INVALID_PHONE',
              message: 'Enter a Zambian mobile number, e.g. 097 123 4567.',
            },
          ],
        });
      }
      input = { ...input, msisdn };
      hint = `${network} ${maskMsisdn(msisdn)}`;
    } else {
      const digits = input.accountNumber.replace(/\D/g, '');
      hint = `${input.bankName} ••••${digits.slice(-4)}`;
    }
    return this.db.run(async (tx) => {
      const tenantId = requireTenantId();
      const count = await tx.payoutMethod.count({ where: { membershipId: actor.membershipId } });
      if (count >= 5) throw new AppError('LIMIT_REACHED', { detail: 'Up to 5 payout methods.' });
      const created = await tx.payoutMethod.create({
        data: {
          tenantId,
          membershipId: actor.membershipId,
          type: input.type,
          detailsEnc: this.gateway.vault.sealValue(tenantId, 'payout-details', JSON.stringify(input)),
          displayHint: hint.slice(0, 80),
          isDefault: count === 0,
        },
        select: { id: true, type: true, displayHint: true, isDefault: true, createdAt: true },
      });
      await this.audit.record(tx, {
        action: 'payout_method.added',
        entityType: 'payout_method',
        entityId: created.id,
        actorId: actor.userId,
        after: { type: input.type, hint: created.displayHint },
      });
      return { ...created, createdAt: created.createdAt.toISOString() };
    });
  }

  async makeDefault(actor: TenantActor, id: string) {
    requireInstructor(actor);
    return this.db.run(async (tx) => {
      const method = await tx.payoutMethod.findFirst({ where: { id, membershipId: actor.membershipId } });
      if (method === null) throw new AppError('NOT_FOUND');
      await tx.payoutMethod.updateMany({
        where: { membershipId: actor.membershipId, isDefault: true },
        data: { isDefault: false },
      });
      await tx.payoutMethod.update({ where: { id }, data: { isDefault: true } });
      return this.listMine(tx, actor);
    });
  }

  async removePayoutMethod(actor: TenantActor, id: string) {
    requireInstructor(actor);
    return this.db.run(async (tx) => {
      const method = await tx.payoutMethod.findFirst({ where: { id, membershipId: actor.membershipId } });
      if (method === null) throw new AppError('NOT_FOUND');
      await tx.payoutMethod.delete({ where: { id } });
      if (method.isDefault) {
        const next = await tx.payoutMethod.findFirst({
          where: { membershipId: actor.membershipId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (next !== null)
          await tx.payoutMethod.update({ where: { id: next.id }, data: { isDefault: true } });
      }
      await this.audit.record(tx, {
        action: 'payout_method.removed',
        entityType: 'payout_method',
        entityId: id,
        actorId: actor.userId,
      });
      return this.listMine(tx, actor);
    });
  }

  private async listMine(tx: TenantTx, actor: TenantActor) {
    const methods = await tx.payoutMethod.findMany({
      where: { membershipId: actor.membershipId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, type: true, displayHint: true, isDefault: true, createdAt: true },
    });
    return { methods: methods.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) };
  }
}

/** Entries whose refund window has passed become AVAILABLE (the release job may still be on its way). */
async function releaseDue(tx: TenantTx, membershipId: string): Promise<void> {
  await tx.ledgerEntry.updateMany({
    where: { instructorMembershipId: membershipId, status: 'PENDING', availableAt: { lte: new Date() } },
    data: { status: 'AVAILABLE', updatedAt: new Date() },
  });
}

async function namesOf(tx: TenantTx, ids: string[]): Promise<Map<string, string>> {
  const profiles = await tx.instructorProfile.findMany({
    where: { membershipId: { in: ids } },
    select: { membershipId: true, displayName: true },
  });
  const members = await tx.tenantMembership.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayNameOverride: true, user: { select: { displayName: true } } },
  });
  const names = new Map(members.map((m) => [m.id, m.displayNameOverride ?? m.user.displayName]));
  for (const p of profiles) names.set(p.membershipId, p.displayName);
  return names;
}

async function defaultHints(tx: TenantTx, ids: string[]): Promise<Map<string, string>> {
  const methods = await tx.payoutMethod.findMany({
    where: { membershipId: { in: ids }, isDefault: true },
    select: { membershipId: true, displayHint: true },
  });
  return new Map(methods.map((m) => [m.membershipId, m.displayHint]));
}

async function payoutViews(tx: TenantTx, where: { instructorMembershipId?: string }) {
  const payouts = await tx.payout.findMany({
    where,
    orderBy: { paidAt: 'desc' },
    take: 500,
    include: { _count: { select: { entries: true } } },
  });
  const names = await namesOf(
    tx,
    payouts.map((p) => p.instructorMembershipId),
  );
  return payouts.map((p) => ({
    id: p.id,
    instructorName: names.get(p.instructorMembershipId) ?? '',
    amount: { amountMinor: Number(p.amountMinor), currency: p.currency },
    externalReference: p.externalReference,
    paidAt: p.paidAt.toISOString(),
    methodHint: (p.methodSnapshot as { hint?: string } | null)?.hint ?? null,
    entryCount: p._count.entries,
    note: p.note,
  }));
}

function requireAdmin(actor: TenantActor): void {
  if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
}

function requireInstructor(actor: TenantActor): void {
  if (!can(actor, 'studio.access')) throw new AppError('FORBIDDEN');
}

const csv = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
