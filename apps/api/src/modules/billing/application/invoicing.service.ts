import { Injectable } from '@nestjs/common';
import { discountSchema, type InvoiceView, pricingPreviewInputSchema } from '@studyhub/contracts';
import { z } from 'zod';

import { type ConsoleActor, recordInSchool, recordPlatform } from '../../console';
import { AppError, TenantDb, type TenantTx } from '../../platform';
import { invoiceIssueJournal, reversal } from '../domain/ledger';
import { clip, type Cycle, cycleContaining, type Span } from '../domain/periods';
import { mergeComponents, type PricedInvoice, priceInvoice, type RevenueAccount } from '../domain/pricing';
import { storedComponents } from './catalogue.service';
import { postJournal, readJournal } from './ledger-poster';
import {
  emptyFigures,
  measureUsage,
  revenueFromJson,
  revenueToJson,
  USAGE_RULES_VERSION,
} from './usage-snapshots';

const DAY_MS = 86_400_000;
const day = (value: string) => new Date(`${value}T00:00:00Z`);
const dateOnly = (value: Date) => value.toISOString().slice(0, 10);
const addDays = (value: string, days: number) => dateOnly(new Date(day(value).getTime() + days * DAY_MS));

/** Platform invoice numbers: SAAS-{year}-{sequence:06}, gap-free per year (PROPOSED prefix). */
const INVOICE_PREFIX = 'SAAS';

/**
 * SaaS invoices (docs/design/saas-billing.md §5.2): drafted in arrears from a contract, its plan version
 * and a frozen usage snapshot; issued with a number, a due date and a ledger journal; voided with a
 * reversing journal. Amounts never change once issued.
 */
@Injectable()
export class InvoicingService {
  constructor(private readonly db: TenantDb) {}

  /** Prices a plan version against sample figures (the plan builder's preview); touches no school. */
  async preview(versionId: string, raw: z.input<typeof pricingPreviewInputSchema>): Promise<InvoiceView> {
    const input = pricingPreviewInputSchema.parse(raw);
    const version = await this.db.runPlatform((tx) =>
      tx.commercialPlanVersion.findUnique({ where: { id: versionId } }),
    );
    if (version === null) throw new AppError('NOT_FOUND');
    // One full cycle starting on the chosen day (anchors stop at 28, which every month has).
    const anchor = Math.min(Number(input.periodStart.slice(8, 10)), 28);
    const cycle = cycleContaining(
      input.periodStart,
      version.billingCycle as Cycle,
      anchor,
      input.periodStart,
    );
    const revenue = {
      FULL: {
        grossMinor: BigInt(input.revenue.grossMinor),
        refundsMinor: BigInt(input.revenue.refundsMinor),
        providerFeesMinor: BigInt(input.revenue.providerFeesMinor),
        transactions: input.revenue.transactions,
      },
      DEPOSIT: emptyFigures(),
      BALANCE: emptyFigures(),
    };
    const priced = priceInvoice({
      components: storedComponents(version.components),
      enabledAddons: storedComponents(version.components)
        .filter((c) => c.type === 'FIXED' && c.optional)
        .map((c) => c.key),
      discounts: [],
      period: cycle,
      cycle,
      invoiceIndex: input.firstInvoice ? 0 : 1,
      includeOneTime: input.firstInvoice,
      chargeRecurring: true,
      students: input.students,
      revenue,
    });
    return view(
      {
        id: null,
        number: null,
        tenantId: null,
        status: 'PREVIEW',
        currency: version.currency,
        issuedAt: null,
        dueAt: null,
      },
      cycle,
      priced,
    );
  }

  /**
   * Drafts the invoice for the contract period containing `forDate` (billing in arrears: the period
   * must have ended). Takes the period's usage snapshot first if there isn't one.
   */
  async draft(actor: ConsoleActor, tenantId: string, forDate: string): Promise<InvoiceView> {
    return this.db.runPlatformIn(tenantId, async (tx) => {
      const contract = await tx.tenantContract.findFirst({
        where: { tenantRef: tenantId, status: { in: ['ACTIVE', 'ENDED'] }, startsOn: { lte: day(forDate) } },
        orderBy: { startsOn: 'desc' },
        include: { planVersion: true },
      });
      if (contract === null) {
        throw new AppError('INVALID_STATE', { detail: 'The school has no contract covering this date.' });
      }
      const version = contract.planVersion;
      const startsOn = dateOnly(contract.startsOn);
      const endsOn = contract.endsOn === null ? null : dateOnly(contract.endsOn);
      const cycle = cycleContaining(
        forDate,
        version.billingCycle as Cycle,
        contract.billingAnchorDay,
        startsOn,
      );
      const period = clip(cycle, startsOn, endsOn);
      if (period === null) {
        throw new AppError('INVALID_STATE', { detail: 'This date is outside the contract.' });
      }
      if (period.end > dateOnly(new Date())) {
        throw new AppError('INVALID_STATE', { detail: 'Invoices are drawn up once their period has ended.' });
      }
      const existing = await tx.saasInvoice.findFirst({
        where: { contractId: contract.id, periodStart: day(period.start), status: { not: 'VOID' } },
        select: { id: true },
      });
      if (existing !== null) {
        throw new AppError('INVALID_STATE', { detail: 'This period is already invoiced.' });
      }
      const snapshot = await snapshotFor(tx, tenantId, period);
      const invoiceIndex = await tx.saasInvoice.count({
        where: { contractId: contract.id, status: { not: 'VOID' } },
      });
      // A trial waives recurring fees until it ends; a period it ends inside is prorated from that day
      // (per-student charges, measured over the whole period, are charged in full: PROPOSED).
      const trialEnd = addDays(startsOn, version.trialDays);
      const chargeRecurring = trialEnd < period.end;
      const pricedSpan =
        trialEnd > period.start && chargeRecurring ? { start: trialEnd, end: period.end } : period;
      const priced = priceInvoice({
        components: mergeComponents(
          storedComponents(version.components),
          storedComponents(contract.overrides),
        ),
        enabledAddons: contract.enabledAddons,
        discounts: z.array(discountSchema).parse(contract.discounts),
        period: pricedSpan,
        cycle,
        invoiceIndex,
        includeOneTime: invoiceIndex === 0,
        chargeRecurring,
        students: snapshot.students,
        revenue: revenueFromJson(snapshot.revenue, version.currency),
      });
      const invoice = await tx.saasInvoice.create({
        data: {
          tenantRef: tenantId,
          contractId: contract.id,
          planVersionId: version.id,
          snapshotId: snapshot.id,
          invoiceIndex,
          periodStart: day(period.start),
          periodEnd: day(period.end),
          currency: version.currency,
          subtotalMinor: priced.subtotalMinor,
          discountMinor: priced.discountMinor,
          taxMinor: priced.taxMinor,
          totalMinor: priced.totalMinor,
          createdBy: actor.userId,
        },
      });
      if (priced.lines.length > 0) {
        await tx.saasInvoiceLine.createMany({
          data: priced.lines.map((line, position) => ({
            invoiceId: invoice.id,
            tenantRef: tenantId,
            position,
            kind: line.kind,
            componentKey: line.componentKey,
            description: line.description,
            quantity: line.quantity,
            unitAmountMinor: line.unitAmountMinor,
            amountMinor: line.amountMinor,
            revenueAccount: line.revenueAccount,
            calculation: line.calculation,
          })),
        });
      }
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'saas_invoice.drafted',
        entityType: 'saas_invoice',
        entityId: invoice.id,
        tenantRef: tenantId,
        after: { period, totalMinor: priced.totalMinor.toString() },
      });
      return this.read(tx, invoice.id);
    });
  }

  /** Numbers the invoice, sets its due date and posts it to the ledger, once. */
  async issue(actor: ConsoleActor, invoiceId: string): Promise<InvoiceView> {
    const tenantId = await this.tenantOf(invoiceId);
    return this.db.runPlatformIn(tenantId, async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM saas_invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      if (locked?.status !== 'DRAFT') {
        throw new AppError('INVALID_STATE', { detail: 'Only a draft invoice can be issued.' });
      }
      const invoice = await tx.saasInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { lines: true, planVersion: { select: { paymentTermsDays: true } } },
      });
      const now = new Date();
      const year = now.getUTCFullYear();
      const [sequence] = await tx.$queryRaw<{ last: number }[]>`
        INSERT INTO saas_invoice_sequence (year, last) VALUES (${year}, 1)
        ON CONFLICT (year) DO UPDATE SET last = saas_invoice_sequence.last + 1
        RETURNING last`;
      const number = `${INVOICE_PREFIX}-${year}-${String(sequence!.last).padStart(6, '0')}`;
      const dueAt = new Date(now.getTime() + invoice.planVersion.paymentTermsDays * DAY_MS);
      await tx.saasInvoice.update({
        where: { id: invoiceId },
        data: { status: 'ISSUED', number, issuedAt: now, dueAt, updatedAt: now },
      });
      const journal = invoiceIssueJournal({
        id: invoice.id,
        number,
        tenantRef: tenantId,
        currency: invoice.currency,
        totalMinor: invoice.totalMinor,
        taxMinor: invoice.taxMinor,
        lines: invoice.lines.map((line) => ({
          revenueAccount: line.revenueAccount as RevenueAccount,
          amountMinor: line.amountMinor,
        })),
      });
      if (journal !== null) await postJournal(tx, journal, { actorId: actor.userId });
      const entry = {
        actorId: actor.userId,
        action: 'saas_invoice.issued',
        entityType: 'saas_invoice',
        entityId: invoiceId,
        tenantRef: tenantId,
        after: { number, totalMinor: invoice.totalMinor.toString(), currency: invoice.currency },
      };
      await recordPlatform(tx, entry);
      await recordInSchool(tx, tenantId, entry);
      return this.read(tx, invoiceId);
    });
  }

  /** Voids a draft, or an issued invoice with a reversing journal. Paid invoices are never voided. */
  async void(actor: ConsoleActor, invoiceId: string, reason: string): Promise<InvoiceView> {
    const tenantId = await this.tenantOf(invoiceId);
    return this.db.runPlatformIn(tenantId, async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM saas_invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      if (locked?.status !== 'DRAFT' && locked?.status !== 'ISSUED') {
        throw new AppError('INVALID_STATE', {
          detail: 'Only a draft or unpaid issued invoice can be voided.',
        });
      }
      const now = new Date();
      await tx.saasInvoice.update({
        where: { id: invoiceId },
        data: { status: 'VOID', voidedAt: now, voidReason: reason, updatedAt: now },
      });
      if (locked.status === 'ISSUED') {
        const posted = await tx.platformLedgerJournal.findFirst({
          where: { sourceType: 'saas_invoice', sourceId: invoiceId, kind: 'SAAS_INVOICE_ISSUED' },
          select: { id: true },
        });
        if (posted !== null) {
          const original = await readJournal(tx, posted.id);
          await postJournal(tx, reversal(original, 'SAAS_INVOICE_VOIDED', `Invoice voided: ${reason}`), {
            actorId: actor.userId,
            reversesJournalId: posted.id,
          });
        }
      }
      const entry = {
        actorId: actor.userId,
        action: 'saas_invoice.voided',
        entityType: 'saas_invoice',
        entityId: invoiceId,
        tenantRef: tenantId,
        before: { status: locked.status },
        after: { reason },
      };
      await recordPlatform(tx, entry);
      if (locked.status === 'ISSUED') await recordInSchool(tx, tenantId, entry);
      return this.read(tx, invoiceId);
    });
  }

  async list(tenantId: string): Promise<{ invoices: InvoiceView[] }> {
    return this.db.runPlatform(async (tx) => {
      const rows = await tx.saasInvoice.findMany({
        where: { tenantRef: tenantId },
        orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
        take: 200,
        select: { id: true },
      });
      return { invoices: await Promise.all(rows.map((r) => this.read(tx, r.id))) };
    });
  }

  async get(invoiceId: string): Promise<InvoiceView> {
    return this.db.runPlatform((tx) => this.read(tx, invoiceId));
  }

  /** Account balances (debits − credits, per currency); optionally for one school. */
  async trialBalance(tenantId?: string) {
    return this.db.runPlatform(async (tx) => {
      const rows = await tx.$queryRaw<
        { account: string; currency: string; debits: bigint; credits: bigint }[]
      >`
        SELECT account_code AS account, currency, sum(debit_minor)::bigint AS debits, sum(credit_minor)::bigint AS credits
          FROM platform_ledger_line
         WHERE ${tenantId ?? null}::uuid IS NULL OR tenant_ref = ${tenantId ?? null}::uuid
         GROUP BY account_code, currency ORDER BY account_code, currency`;
      return {
        accounts: rows.map((r) => ({
          account: r.account,
          currency: r.currency,
          debitsMinor: r.debits.toString(),
          creditsMinor: r.credits.toString(),
          balanceMinor: (r.debits - r.credits).toString(),
        })),
      };
    });
  }

  private async tenantOf(invoiceId: string): Promise<string> {
    const found = await this.db.runPlatform((tx) =>
      tx.saasInvoice.findUnique({ where: { id: invoiceId }, select: { tenantRef: true } }),
    );
    if (found === null) throw new AppError('NOT_FOUND');
    return found.tenantRef;
  }

  private async read(tx: TenantTx, invoiceId: string): Promise<InvoiceView> {
    const invoice = await tx.saasInvoice.findUnique({
      where: { id: invoiceId },
      include: { lines: { orderBy: { position: 'asc' } } },
    });
    if (invoice === null) throw new AppError('NOT_FOUND');
    return {
      id: invoice.id,
      number: invoice.number,
      tenantId: invoice.tenantRef,
      status: invoice.status,
      currency: invoice.currency,
      periodStart: dateOnly(invoice.periodStart),
      periodEnd: dateOnly(invoice.periodEnd),
      subtotalMinor: invoice.subtotalMinor.toString(),
      discountMinor: invoice.discountMinor.toString(),
      taxMinor: invoice.taxMinor.toString(),
      totalMinor: invoice.totalMinor.toString(),
      issuedAt: invoice.issuedAt?.toISOString() ?? null,
      dueAt: invoice.dueAt?.toISOString() ?? null,
      lines: invoice.lines.map((line) => ({
        kind: line.kind as InvoiceView['lines'][number]['kind'],
        componentKey: line.componentKey,
        description: line.description,
        quantity: line.quantity.toString(),
        unitAmountMinor: line.unitAmountMinor.toString(),
        amountMinor: line.amountMinor.toString(),
        revenueAccount: line.revenueAccount,
        calculation: line.calculation as Record<string, string | number | boolean>,
      })),
    };
  }
}

/** The period's usage snapshot, taken now if there isn't one (frozen: never retaken). */
async function snapshotFor(tx: TenantTx, tenantId: string, period: Span) {
  const existing = await tx.usageSnapshot.findFirst({
    where: { tenantRef: tenantId, periodStart: day(period.start), periodEnd: day(period.end) },
  });
  const row =
    existing ??
    (await (async () => {
      const usage = await measureUsage(tx, period);
      return tx.usageSnapshot.create({
        data: {
          tenantRef: tenantId,
          periodStart: day(period.start),
          periodEnd: day(period.end),
          students: usage.students,
          revenue: revenueToJson(usage.revenue) as object,
          rules: { version: USAGE_RULES_VERSION },
        },
      });
    })());
  return {
    id: row.id,
    students: row.students as { ACTIVE_LEARNERS: number; ENROLLED_LEARNERS: number },
    revenue: row.revenue,
  };
}

function view(
  head: Pick<InvoiceView, 'id' | 'number' | 'tenantId' | 'status' | 'currency' | 'issuedAt' | 'dueAt'>,
  period: Span,
  priced: PricedInvoice,
): InvoiceView {
  return {
    ...head,
    periodStart: period.start,
    periodEnd: period.end,
    subtotalMinor: priced.subtotalMinor.toString(),
    discountMinor: priced.discountMinor.toString(),
    taxMinor: priced.taxMinor.toString(),
    totalMinor: priced.totalMinor.toString(),
    lines: priced.lines.map((line) => ({
      kind: line.kind,
      componentKey: line.componentKey,
      description: line.description,
      quantity: line.quantity.toString(),
      unitAmountMinor: line.unitAmountMinor.toString(),
      amountMinor: line.amountMinor.toString(),
      revenueAccount: line.revenueAccount,
      calculation: line.calculation,
    })),
  };
}
