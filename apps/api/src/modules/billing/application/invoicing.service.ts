import { Injectable } from '@nestjs/common';
import { type InvoiceView, pricingPreviewInputSchema } from '@studyhub/contracts';
import type { z } from 'zod';

import { AppError, SecretBox, TenantDb } from '../../platform';
import { type Cycle, cycleContaining, type Span } from '../domain/periods';
import { type PricedInvoice, priceInvoice } from '../domain/pricing';
import { storedComponents } from './catalogue.service';
import { type BillingActor, draftInvoice, issueInvoice, readInvoice, voidInvoice } from './invoices';
import { emptyFigures } from './usage-snapshots';

/**
 * SaaS invoices in the console (docs/design/saas-billing.md §5.2): previews, drafts, issuing and voiding,
 * each in one platform transaction scoped to the school. The work itself is in `invoices.ts`, shared with
 * the scheduled billing cycle.
 */
@Injectable()
export class InvoicingService {
  constructor(
    private readonly db: TenantDb,
    private readonly box: SecretBox,
  ) {}

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
    const components = storedComponents(version.components);
    const priced = priceInvoice({
      components,
      enabledAddons: components.filter((c) => c.type === 'FIXED' && c.optional).map((c) => c.key),
      discounts: [],
      period: cycle,
      cycle,
      invoiceIndex: input.firstInvoice ? 0 : 1,
      includeOneTime: input.firstInvoice,
      chargeRecurring: true,
      students: input.students,
      revenue: {
        FULL: {
          grossMinor: BigInt(input.revenue.grossMinor),
          refundsMinor: BigInt(input.revenue.refundsMinor),
          providerFeesMinor: BigInt(input.revenue.providerFeesMinor),
          transactions: input.revenue.transactions,
        },
        DEPOSIT: emptyFigures(),
        BALANCE: emptyFigures(),
      },
    });
    return previewView(version.currency, cycle, priced);
  }

  /** Drafts the recurring invoice for the contract period containing `forDate` (in arrears). */
  async draft(actor: BillingActor, tenantId: string, forDate: string): Promise<InvoiceView> {
    return this.db.runPlatformIn(tenantId, async (tx) => {
      const id = await draftInvoice(tx, actor, tenantId, { forDate });
      return readInvoice(tx, id);
    });
  }

  async issue(actor: BillingActor, invoiceId: string): Promise<InvoiceView> {
    const tenantId = await this.tenantOf(invoiceId);
    return this.db.runPlatformIn(tenantId, async (tx) => {
      await issueInvoice(tx, { box: this.box }, actor, invoiceId);
      return readInvoice(tx, invoiceId);
    });
  }

  async void(actor: BillingActor, invoiceId: string, reason: string): Promise<InvoiceView> {
    const tenantId = await this.tenantOf(invoiceId);
    return this.db.runPlatformIn(tenantId, async (tx) => {
      await voidInvoice(tx, actor, invoiceId, reason);
      return readInvoice(tx, invoiceId);
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
      return { invoices: await Promise.all(rows.map((r) => readInvoice(tx, r.id))) };
    });
  }

  async get(invoiceId: string): Promise<InvoiceView> {
    return this.db.runPlatform((tx) => readInvoice(tx, invoiceId));
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

  async tenantOf(invoiceId: string): Promise<string> {
    const found = await this.db.runPlatform((tx) =>
      tx.saasInvoice.findUnique({ where: { id: invoiceId }, select: { tenantRef: true } }),
    );
    if (found === null) throw new AppError('NOT_FOUND');
    return found.tenantRef;
  }
}

function previewView(currency: string, period: Span, priced: PricedInvoice): InvoiceView {
  return {
    id: null,
    number: null,
    tenantId: null,
    kind: 'RECURRING',
    status: 'PREVIEW',
    currency,
    periodStart: period.start,
    periodEnd: period.end,
    subtotalMinor: priced.subtotalMinor.toString(),
    discountMinor: priced.discountMinor.toString(),
    taxMinor: priced.taxMinor.toString(),
    totalMinor: priced.totalMinor.toString(),
    amountPaidMinor: '0',
    issuedAt: null,
    dueAt: null,
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
