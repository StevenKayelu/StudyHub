import { discountSchema, type InvoiceView } from '@studyhub/contracts';
import { z } from 'zod';

import { recordInSchool, recordPlatform } from '../../console';
import { addToOutbox, AppError, type SecretBox, type TenantTx } from '../../platform';
import { invoiceIssueJournal, reversal } from '../domain/ledger';
import { clip, type Cycle, cycleContaining, type Span } from '../domain/periods';
import { mergeComponents, priceInvoice, type RevenueAccount } from '../domain/pricing';
import { noticeTimes } from '../domain/subscription-rules';
import { storedComponents } from './catalogue.service';
import { postJournal, readJournal } from './ledger-poster';
import { notifyOwners } from './notices';
import {
  emptyFigures,
  measureUsage,
  revenueFromJson,
  revenueToJson,
  USAGE_RULES_VERSION,
} from './usage-snapshots';

/** Who does a billing action: a staff member, or the platform itself (a scheduled job: null). */
export interface BillingActor {
  userId: string | null;
}
export const SYSTEM: BillingActor = { userId: null };

/** Queue of invoice reminders (docs/design/saas-billing.md §10). */
export const BILLING_NOTICE_JOB = 'billing.notice';

const DAY_MS = 86_400_000;
export const day = (value: string) => new Date(`${value}T00:00:00Z`);
export const dateOnly = (value: Date) => value.toISOString().slice(0, 10);
export const addDays = (value: string, days: number) =>
  dateOnly(new Date(day(value).getTime() + days * DAY_MS));

/** Platform invoice numbers: SAAS-{year}-{sequence:06}, gap-free per year. */
const INVOICE_PREFIX = 'SAAS';

/**
 * Drafts a school's invoice in the caller's platform transaction (scoped to the school).
 * RECURRING: the contract period containing `forDate`, in arrears (the period must have ended), from the
 * period's frozen usage snapshot. SETUP: the contract's one-time charges, issued up front, used when the
 * contract activates the school only after its setup fee is paid.
 */
export async function draftInvoice(
  tx: TenantTx,
  actor: BillingActor,
  tenantId: string,
  input: { forDate: string; kind?: 'RECURRING' | 'SETUP'; now?: Date },
): Promise<string> {
  const kind = input.kind ?? 'RECURRING';
  const now = input.now ?? new Date();
  const contract = await tx.tenantContract.findFirst({
    where: {
      tenantRef: tenantId,
      status: { in: ['ACTIVE', 'ENDED'] },
      startsOn: { lte: day(input.forDate) },
    },
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
    input.forDate,
    version.billingCycle as Cycle,
    contract.billingAnchorDay,
    startsOn,
  );
  const period: Span | null =
    kind === 'SETUP' ? { start: startsOn, end: addDays(startsOn, 1) } : clip(cycle, startsOn, endsOn);
  if (period === null) {
    throw new AppError('INVALID_STATE', { detail: 'This date is outside the contract.' });
  }
  if (kind === 'RECURRING' && period.end > dateOnly(now)) {
    throw new AppError('INVALID_STATE', { detail: 'Invoices are drawn up once their period has ended.' });
  }
  const existing = await tx.saasInvoice.findFirst({
    where: { contractId: contract.id, kind, periodStart: day(period.start), status: { not: 'VOID' } },
    select: { id: true },
  });
  if (existing !== null) {
    throw new AppError('INVALID_STATE', { detail: 'This period is already invoiced.' });
  }
  const invoiceIndex = await tx.saasInvoice.count({
    where: { contractId: contract.id, kind: 'RECURRING', status: { not: 'VOID' } },
  });
  const setupBilled =
    (await tx.saasInvoice.count({
      where: { contractId: contract.id, kind: 'SETUP', status: { not: 'VOID' } },
    })) > 0;
  const components = mergeComponents(
    storedComponents(version.components),
    storedComponents(contract.overrides),
  );
  const discounts = z.array(discountSchema).parse(contract.discounts);

  let snapshotId: string | null = null;
  let priced;
  if (kind === 'SETUP') {
    priced = priceInvoice({
      components,
      enabledAddons: contract.enabledAddons,
      discounts: discounts.filter((d) => d.appliesTo.length > 0), // only discounts that name one-time charges
      period,
      cycle: period,
      invoiceIndex: 0,
      includeOneTime: true,
      chargeRecurring: false,
      students: { ACTIVE_LEARNERS: 0, ENROLLED_LEARNERS: 0 },
      revenue: { FULL: emptyFigures(), DEPOSIT: emptyFigures(), BALANCE: emptyFigures() },
    });
    // Revenue share is earned on sales, never billed on a setup invoice.
    priced.lines = priced.lines.filter((line) => line.kind === 'ONE_TIME' || line.kind === 'DISCOUNT');
  } else {
    const snapshot = await snapshotFor(tx, tenantId, period);
    snapshotId = snapshot.id;
    // A trial waives recurring fees until it ends; a period it ends inside is prorated from that day
    // (per-student charges, measured over the whole period, are charged in full: PROPOSED).
    const trialEnd = addDays(startsOn, version.trialDays);
    const chargeRecurring = trialEnd < period.end;
    const pricedSpan =
      trialEnd > period.start && chargeRecurring ? { start: trialEnd, end: period.end } : period;
    priced = priceInvoice({
      components,
      enabledAddons: contract.enabledAddons,
      discounts,
      period: pricedSpan,
      cycle,
      invoiceIndex,
      includeOneTime: invoiceIndex === 0 && !setupBilled,
      chargeRecurring,
      students: snapshot.students,
      revenue: revenueFromJson(snapshot.revenue, version.currency),
    });
  }
  const subtotal = priced.lines.filter((l) => l.kind !== 'DISCOUNT').reduce((s, l) => s + l.amountMinor, 0n);
  const discount = -priced.lines.filter((l) => l.kind === 'DISCOUNT').reduce((s, l) => s + l.amountMinor, 0n);
  const invoice = await tx.saasInvoice.create({
    data: {
      tenantRef: tenantId,
      contractId: contract.id,
      planVersionId: version.id,
      snapshotId,
      kind,
      invoiceIndex: kind === 'SETUP' ? 0 : invoiceIndex,
      periodStart: day(period.start),
      periodEnd: day(period.end),
      currency: version.currency,
      subtotalMinor: subtotal,
      discountMinor: discount,
      taxMinor: 0n,
      totalMinor: subtotal - discount,
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
    after: { kind, period, totalMinor: (subtotal - discount).toString() },
  });
  return invoice.id;
}

/**
 * Numbers the invoice, sets its due date, posts it to the ledger and tells the school's owners, once.
 * An invoice that charges nothing (a trial period without usage) is settled at once.
 */
export async function issueInvoice(
  tx: TenantTx,
  deps: { box: SecretBox },
  actor: BillingActor,
  invoiceId: string,
  now = new Date(),
): Promise<void> {
  const [locked] = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM saas_invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;
  if (locked?.status !== 'DRAFT') {
    throw new AppError('INVALID_STATE', { detail: 'Only a draft invoice can be issued.' });
  }
  const invoice = await tx.saasInvoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { lines: true, planVersion: { select: { paymentTermsDays: true } } },
  });
  const year = now.getUTCFullYear();
  const [sequence] = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO saas_invoice_sequence (year, last) VALUES (${year}, 1)
    ON CONFLICT (year) DO UPDATE SET last = saas_invoice_sequence.last + 1
    RETURNING last`;
  const number = `${INVOICE_PREFIX}-${year}-${String(sequence!.last).padStart(6, '0')}`;
  // Setup invoices are due at once: the school goes live when it's paid.
  const termsDays = invoice.kind === 'SETUP' ? 0 : invoice.planVersion.paymentTermsDays;
  const dueAt = new Date(now.getTime() + termsDays * DAY_MS);
  await tx.saasInvoice.update({
    where: { id: invoiceId },
    data: { status: 'ISSUED', number, issuedAt: now, dueAt, updatedAt: now },
  });
  const journal = invoiceIssueJournal({
    id: invoice.id,
    number,
    tenantRef: invoice.tenantRef,
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
    tenantRef: invoice.tenantRef,
    after: { number, totalMinor: invoice.totalMinor.toString(), currency: invoice.currency },
  };
  await recordPlatform(tx, entry);
  await recordInSchool(tx, invoice.tenantRef, entry);
  if (invoice.totalMinor === 0n) {
    await tx.saasInvoice.update({
      where: { id: invoiceId },
      data: { status: 'PAID', paidAt: now, updatedAt: now },
    });
    return;
  }
  await notifyOwners(tx, deps.box, invoice.tenantRef, 'ISSUED', {
    number,
    amountMinor: invoice.totalMinor,
    currency: invoice.currency,
    dueAt,
  });
  for (const notice of noticeTimes(now, dueAt)) {
    const outboxId = await addToOutbox(tx, BILLING_NOTICE_JOB, { invoiceId, kind: notice.kind });
    await tx.outbox.update({ where: { id: outboxId }, data: { availableAt: notice.at } });
  }
}

/** Voids a draft, or an unpaid issued invoice with a reversing journal (the database refuses paid ones). */
export async function voidInvoice(
  tx: TenantTx,
  actor: BillingActor,
  invoiceId: string,
  reason: string,
): Promise<void> {
  const [locked] = await tx.$queryRaw<{ status: string; tenant_ref: string; amount_paid_minor: bigint }[]>`
    SELECT status, tenant_ref, amount_paid_minor FROM saas_invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`;
  if ((locked?.status !== 'DRAFT' && locked?.status !== 'ISSUED') || locked.amount_paid_minor > 0n) {
    throw new AppError('INVALID_STATE', { detail: 'Only a draft or unpaid issued invoice can be voided.' });
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
    tenantRef: locked.tenant_ref,
    before: { status: locked.status },
    after: { reason },
  };
  await recordPlatform(tx, entry);
  if (locked.status === 'ISSUED') await recordInSchool(tx, locked.tenant_ref, entry);
}

export async function readInvoice(tx: TenantTx, invoiceId: string): Promise<InvoiceView> {
  const invoice = await tx.saasInvoice.findUnique({
    where: { id: invoiceId },
    include: { lines: { orderBy: { position: 'asc' } } },
  });
  if (invoice === null) throw new AppError('NOT_FOUND');
  return {
    id: invoice.id,
    number: invoice.number,
    tenantId: invoice.tenantRef,
    kind: invoice.kind,
    status: invoice.status,
    currency: invoice.currency,
    periodStart: dateOnly(invoice.periodStart),
    periodEnd: dateOnly(invoice.periodEnd),
    subtotalMinor: invoice.subtotalMinor.toString(),
    discountMinor: invoice.discountMinor.toString(),
    taxMinor: invoice.taxMinor.toString(),
    totalMinor: invoice.totalMinor.toString(),
    amountPaidMinor: invoice.amountPaidMinor.toString(),
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
