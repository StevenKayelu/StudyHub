import { Inject, Injectable } from '@nestjs/common';
import type { SettlementDetail, SettlementList, SettlementReportSummary } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import { AppError, parseCsv, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import {
  type LocalPayment,
  matchSettlement,
  readStatementCsv,
  type SettledTransaction,
} from '../domain/settlement-match';
import { PAYMENT_GATEWAY, PaymentGateway } from '../infra/payment-gateway';
import { AdminOrdersService } from './admin-orders.service';
import { activeAccount } from './checkout.service';

const DAY_MS = 86_400_000;

type ReportRow = {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  source: 'API' | 'CSV';
  status: 'PROCESSING' | 'READY' | 'FAILED';
  providerCount: number;
  localCount: number;
  matchedCount: number;
  mismatchCount: number;
  error: string | null;
  createdAt: Date;
  items?: { resolution: string | null }[];
};

function summary(row: ReportRow): SettlementReportSummary {
  return {
    id: row.id,
    periodStart: row.periodStart.toISOString().slice(0, 10),
    periodEnd: row.periodEnd.toISOString().slice(0, 10),
    source: row.source,
    status: row.status,
    providerCount: row.providerCount,
    localCount: row.localCount,
    matchedCount: row.matchedCount,
    mismatchCount: row.mismatchCount,
    unresolvedCount: (row.items ?? []).filter((item) => item.resolution === null).length,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Provider settlement reconciliation (W7, S-AD20, SHOULD): the provider's settled transactions (its list
 * API, or the CSV statement the admin uploads) against what StudyHub recorded as paid on the school's
 * active account, matched by reference. Each difference is resolved on its own and audited.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly orders: AdminOrdersService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async list(actor: TenantActor): Promise<SettlementList> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const account = await activeAccount(tx);
      const reports = await tx.settlementReport.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { items: { select: { resolution: true } } },
      });
      return {
        reports: reports.map(summary),
        canFetch: account?.capabilities?.transactionListApi === true,
        hasAccount: account !== null,
      };
    });
  }

  async detail(actor: TenantActor, id: string): Promise<SettlementDetail> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const report = await tx.settlementReport.findFirst({
        where: { id },
        include: { items: { orderBy: [{ kind: 'asc' }, { reference: 'asc' }] } },
      });
      if (report === null) throw new AppError('NOT_FOUND');
      const paymentIds = report.items.map((i) => i.paymentId).filter((p): p is string => p !== null);
      const payments =
        paymentIds.length === 0
          ? []
          : await tx.payment.findMany({
              where: { id: { in: paymentIds } },
              select: { id: true, orderId: true },
            });
      const orderOf = new Map(payments.map((p) => [p.id, p.orderId]));
      return {
        report: summary(report),
        items: report.items.map((item) => ({
          id: item.id,
          reference: item.reference,
          kind: item.kind,
          paymentId: item.paymentId,
          orderId: item.paymentId === null ? null : (orderOf.get(item.paymentId) ?? null),
          localAmountMinor: item.localAmountMinor === null ? null : Number(item.localAmountMinor),
          providerAmountMinor: item.providerAmountMinor === null ? null : Number(item.providerAmountMinor),
          currency: item.currency,
          resolution: item.resolution,
          note: item.note,
          resolvedAt: item.resolvedAt?.toISOString() ?? null,
        })),
      };
    });
  }

  async create(
    actor: TenantActor,
    input:
      { source: 'API'; from: string; to: string } | { source: 'CSV'; from: string; to: string; csv: string },
  ): Promise<{ id: string }> {
    requireAdmin(actor);
    if (actor.support !== undefined) throw new AppError('SUPPORT_ACTION_EXCLUDED');
    const start = new Date(`${input.from}T00:00:00Z`);
    const end = new Date(Date.parse(`${input.to}T00:00:00Z`) + DAY_MS);
    if (end <= start || end.getTime() - start.getTime() > 93 * DAY_MS) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'to', code: 'range', message: 'Pick a range of up to three months' }],
      });
    }
    const tenantId = requireTenantId();
    const account = await this.db.run((tx) => activeAccount(tx));
    if (account === null)
      throw new AppError('INVALID_STATE', { detail: 'Connect and activate a payment account first.' });

    let provider: SettledTransaction[];
    if (input.source === 'CSV') {
      const parsed = readStatementCsv(parseCsv(input.csv));
      if (!parsed.ok) {
        throw new AppError('VALIDATION_FAILED', {
          errors: parsed.errors.map((e) => ({
            field: 'csv',
            code: 'line',
            message: `Line ${e.line}: ${e.message}`,
          })),
        });
      }
      provider = parsed.transactions;
    } else {
      const adapter = this.gateway.requireProvider(account.provider);
      if (account.capabilities?.transactionListApi !== true || adapter.listTransactions === undefined) {
        throw new AppError('PAYMENT_METHOD_NOT_SUPPORTED', {
          detail: "Your payment provider can't list transactions. Upload its statement CSV instead.",
        });
      }
      const opened = this.gateway.open(tenantId, account);
      provider = await this.gateway.call(account.id, () => adapter.listTransactions!(opened, { start, end }));
    }

    return this.db.run(async (tx) => {
      const local = await localPayments(
        tx,
        account.id,
        start,
        end,
        provider.map((p) => p.reference),
      );
      const result = matchSettlement(local, provider);
      const report = await tx.settlementReport.create({
        data: {
          tenantId,
          paymentAccountId: account.id,
          periodStart: start,
          periodEnd: new Date(end.getTime() - DAY_MS),
          source: input.source,
          status: 'READY',
          providerCount: provider.length,
          localCount: local.filter((p) => p.recordedPaid).length,
          matchedCount: result.matched,
          mismatchCount: result.items.length,
          createdBy: actor.membershipId,
        },
        select: { id: true },
      });
      if (result.items.length > 0) {
        await tx.settlementItem.createMany({
          data: result.items.map((item) => ({
            tenantId,
            reportId: report.id,
            reference: item.reference,
            kind: item.kind,
            paymentId: item.paymentId,
            localAmountMinor: item.localAmountMinor === null ? null : BigInt(item.localAmountMinor),
            providerAmountMinor: item.providerAmountMinor === null ? null : BigInt(item.providerAmountMinor),
            currency: item.currency,
          })),
        });
      }
      await this.audit.record(tx, {
        action: 'settlement.reconciled',
        entityType: 'settlement_report',
        entityId: report.id,
        actorId: actor.userId,
        after: {
          source: input.source,
          from: input.from,
          to: input.to,
          matched: result.matched,
          mismatches: result.items.length,
        },
      });
      return report;
    });
  }

  /** Re-check with the provider, accept, start a refund (on the order page) or add a note. */
  async resolve(
    actor: TenantActor,
    reportId: string,
    itemId: string,
    input: { action: 'RECHECK' | 'ACCEPT' | 'REFUND' | 'NOTE'; note?: string | undefined },
  ): Promise<void> {
    requireAdmin(actor);
    const item = await this.db.run((tx) => tx.settlementItem.findFirst({ where: { id: itemId, reportId } }));
    if (item === null) throw new AppError('NOT_FOUND');
    if (input.action === 'NOTE' && (input.note ?? '').trim() === '') {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'note', code: 'required', message: 'Add a note' }],
      });
    }
    if (input.action === 'RECHECK') {
      if (item.paymentId === null) {
        throw new AppError('INVALID_STATE', {
          detail: 'StudyHub has no payment with this reference to re-check.',
        });
      }
      await this.orders.recheck(actor, item.paymentId);
    }
    const resolution = {
      RECHECK: 'RECHECKED',
      ACCEPT: 'ACCEPTED',
      REFUND: 'REFUND_STARTED',
      NOTE: 'NOTED',
    } as const;
    await this.db.run(async (tx) => {
      await tx.settlementItem.update({
        where: { id: itemId },
        data: {
          resolution: resolution[input.action],
          note: input.note?.trim() || null,
          resolvedBy: actor.membershipId,
          resolvedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        action: 'settlement.item_resolved',
        entityType: 'settlement_item',
        entityId: itemId,
        actorId: actor.userId,
        after: {
          reference: item.reference,
          kind: item.kind,
          resolution: resolution[input.action],
          note: input.note ?? null,
        },
      });
    });
  }
}

/** StudyHub's side: payments on the account recorded as paid in the period, plus any with a listed reference. */
async function localPayments(
  tx: TenantTx,
  accountId: string,
  start: Date,
  end: Date,
  references: string[],
): Promise<LocalPayment[]> {
  const uuids = references.filter((r) => /^[0-9a-f-]{36}$/i.test(r));
  const rows = await tx.payment.findMany({
    where: {
      paymentAccountId: accountId,
      OR: [
        { status: { in: ['SUCCEEDED', 'REFUNDED'] }, confirmedAt: { gte: start, lt: end } },
        ...(uuids.length > 0 ? [{ reference: { in: uuids } }] : []),
      ],
    },
    select: { id: true, reference: true, amountMinor: true, currency: true, status: true, confirmedAt: true },
  });
  return rows.map((p) => ({
    reference: p.reference,
    paymentId: p.id,
    amountMinor: Number(p.amountMinor),
    currency: p.currency,
    // Paid payments outside the period appear only when the provider listed their reference, so a
    // settlement that crosses the period boundary still matches.
    recordedPaid: p.status === 'SUCCEEDED' || p.status === 'REFUNDED',
  }));
}

function requireAdmin(actor: TenantActor): void {
  if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
}
