import type { BillableStudentRule, Discount, PlanComponent } from '@studyhub/contracts';

import { applyBps, max0, minBig, mulDivHalfUp } from './money';
import { daysIn, type Span } from './periods';

/**
 * The SaaS pricing engine (docs/design/saas-billing.md §3, §5). Pure: given a plan version's components
 * (with the contract's overrides), the billed span, frozen usage and revenue figures, it returns the
 * invoice lines and totals. The same inputs always give the same invoice.
 *
 * Billing is in arrears: an invoice for a period is drawn up at its end, from that period's snapshot
 * (PROPOSED). Fixed amounts and minimums are per full cycle and prorated by days for a partial period;
 * usage (students, revenue) is charged as measured, never prorated.
 */

export type LineKind =
  | 'LICENCE'
  | 'HOSTING'
  | 'MAINTENANCE'
  | 'SERVICE'
  | 'PER_STUDENT'
  | 'OVERAGE'
  | 'REVENUE_SHARE'
  | 'TRANSACTION_FEE'
  | 'MINIMUM_TOPUP'
  | 'ONE_TIME'
  | 'DISCOUNT';

/** Ledger revenue accounts (§5.1). */
export type RevenueAccount =
  | 'revenue.licence'
  | 'revenue.hosting'
  | 'revenue.maintenance'
  | 'revenue.services'
  | 'revenue.usage'
  | 'revenue.setup'
  | 'revenue.commission'
  | 'revenue.discounts';

export interface PricedLine {
  kind: LineKind;
  componentKey: string;
  description: string;
  quantity: bigint;
  unitAmountMinor: bigint;
  /** Negative for discounts. */
  amountMinor: bigint;
  revenueAccount: RevenueAccount;
  /** The inputs of the calculation, shown with the line for transparency. */
  calculation: Record<string, string | number | boolean>;
}

export interface RevenueFigures {
  grossMinor: bigint;
  refundsMinor: bigint;
  providerFeesMinor: bigint;
  transactions: number;
}

export interface PricingInput {
  components: readonly PlanComponent[];
  enabledAddons: readonly string[];
  discounts: readonly Discount[];
  /** The billed span and the full cycle it belongs to (equal unless the contract starts or ends inside it). */
  period: Span;
  cycle: Span;
  /** 0 for the contract's first invoice; discounts limited to N invoices use it. */
  invoiceIndex: number;
  /** One-time charges are billed on the first invoice only. */
  includeOneTime: boolean;
  /** False during a trial: recurring charges are not billed. */
  chargeRecurring: boolean;
  students: Record<BillableStudentRule, number>;
  /** Eligible education collections in the period, per order-item part. */
  revenue: Record<'FULL' | 'DEPOSIT' | 'BALANCE', RevenueFigures>;
}

export interface PricedInvoice {
  lines: PricedLine[];
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
}

const FIXED_KIND: Record<string, { kind: LineKind; account: RevenueAccount }> = {
  LICENCE: { kind: 'LICENCE', account: 'revenue.licence' },
  HOSTING: { kind: 'HOSTING', account: 'revenue.hosting' },
  MAINTENANCE: { kind: 'MAINTENANCE', account: 'revenue.maintenance' },
};
const fixedKind = (category: string) =>
  FIXED_KIND[category] ?? { kind: 'SERVICE' as const, account: 'revenue.services' as const };

const ONE_TIME_ACCOUNT: Record<string, RevenueAccount> = {
  LICENCE: 'revenue.licence',
  SERVICE: 'revenue.services',
};

/** Merges a contract's negotiated components over the plan's (same key replaces; new keys are added). */
export function mergeComponents(
  plan: readonly PlanComponent[],
  overrides: readonly PlanComponent[],
): PlanComponent[] {
  const byKey = new Map(overrides.map((c) => [c.key, c]));
  const merged = plan.map((c) => byKey.get(c.key) ?? c);
  const planKeys = new Set(plan.map((c) => c.key));
  return [...merged, ...overrides.filter((c) => !planKeys.has(c.key))];
}

export function priceInvoice(input: PricingInput): PricedInvoice {
  const periodDays = BigInt(daysIn(input.period));
  const cycleDays = BigInt(daysIn(input.cycle));
  if (periodDays <= 0n || cycleDays <= 0n || periodDays > cycleDays) {
    throw new RangeError('The billed period must lie within its cycle');
  }
  const full = periodDays === cycleDays;
  const prorate = (amount: bigint) => (full ? amount : mulDivHalfUp(amount, periodDays, cycleDays));
  const proration = full ? {} : { periodDays: Number(periodDays), cycleDays: Number(cycleDays) };
  const lines: PricedLine[] = [];

  for (const component of input.components) {
    switch (component.type) {
      case 'FIXED': {
        if (!input.chargeRecurring) break;
        if (component.optional && !input.enabledAddons.includes(component.key)) break;
        const amount = prorate(BigInt(component.amountMinor));
        if (amount === 0n) break;
        const { kind, account } = fixedKind(component.category);
        lines.push({
          kind,
          componentKey: component.key,
          description: component.label,
          quantity: 1n,
          unitAmountMinor: amount,
          amountMinor: amount,
          revenueAccount: account,
          calculation: { cycleAmountMinor: String(component.amountMinor), ...proration },
        });
        break;
      }
      case 'PER_STUDENT': {
        if (!input.chargeRecurring) break;
        const students = input.students[component.billableRule];
        const included = component.includedStudents;
        const threshold = component.overageThreshold ?? Number.POSITIVE_INFINITY;
        const normal = Math.max(0, Math.min(students, threshold) - included);
        const over = Math.max(0, students - Math.max(threshold, included));
        const unit = BigInt(component.unitAmountMinor);
        const overUnit = BigInt(component.overageUnitAmountMinor ?? component.unitAmountMinor);
        const base = { rule: component.billableRule, students, includedStudents: included };
        let charged = 0n;
        if (normal > 0) {
          const amount = BigInt(normal) * unit;
          charged += amount;
          lines.push({
            kind: 'PER_STUDENT',
            componentKey: component.key,
            description: component.label,
            quantity: BigInt(normal),
            unitAmountMinor: unit,
            amountMinor: amount,
            revenueAccount: 'revenue.usage',
            calculation: base,
          });
        }
        if (over > 0) {
          const amount = BigInt(over) * overUnit;
          charged += amount;
          lines.push({
            kind: 'OVERAGE',
            componentKey: component.key,
            description: `${component.label}: above ${component.overageThreshold} students`,
            quantity: BigInt(over),
            unitAmountMinor: overUnit,
            amountMinor: amount,
            revenueAccount: 'revenue.usage',
            calculation: { ...base, overageThreshold: component.overageThreshold ?? 0 },
          });
        }
        pushMinimum(
          lines,
          component.key,
          component.label,
          prorate(BigInt(component.minimumMinor)),
          charged,
          'revenue.usage',
          proration,
        );
        break;
      }
      case 'REVENUE_SHARE': {
        // Revenue share is earned on collections whether or not recurring fees are charged (a trial
        // waives the subscription, not the commission on sales).
        let gross = 0n;
        let refunds = 0n;
        let fees = 0n;
        let transactions = 0;
        for (const part of component.eligibleParts) {
          const figures = input.revenue[part];
          gross += figures.grossMinor;
          refunds += figures.refundsMinor;
          fees += figures.providerFeesMinor;
          transactions += figures.transactions;
        }
        const base = max0(
          gross -
            (component.refundsReduceBase ? refunds : 0n) -
            (component.providerFeesReduceBase ? fees : 0n),
        );
        const commission = applyBps(base, component.bps);
        const calculation = {
          eligibleParts: component.eligibleParts.join(','),
          grossMinor: String(gross),
          refundsMinor: String(component.refundsReduceBase ? refunds : 0n),
          providerFeesMinor: String(component.providerFeesReduceBase ? fees : 0n),
          baseMinor: String(base),
          bps: component.bps,
        };
        let charged = 0n;
        if (commission > 0n) {
          charged += commission;
          lines.push({
            kind: 'REVENUE_SHARE',
            componentKey: component.key,
            description: component.label,
            quantity: 1n,
            unitAmountMinor: commission,
            amountMinor: commission,
            revenueAccount: 'revenue.commission',
            calculation,
          });
        }
        const perTransaction = BigInt(component.fixedFeePerTransactionMinor);
        if (perTransaction > 0n && transactions > 0) {
          const amount = perTransaction * BigInt(transactions);
          charged += amount;
          lines.push({
            kind: 'TRANSACTION_FEE',
            componentKey: component.key,
            description: `${component.label}: per transaction`,
            quantity: BigInt(transactions),
            unitAmountMinor: perTransaction,
            amountMinor: amount,
            revenueAccount: 'revenue.commission',
            calculation: { transactions },
          });
        }
        pushMinimum(
          lines,
          component.key,
          component.label,
          prorate(BigInt(component.minimumMinor)),
          charged,
          'revenue.commission',
          proration,
        );
        break;
      }
      case 'ONE_TIME': {
        if (!input.includeOneTime || component.amountMinor === 0) break;
        const amount = BigInt(component.amountMinor);
        const licence = component.licence;
        lines.push({
          kind: 'ONE_TIME',
          componentKey: component.key,
          description: component.label,
          quantity: 1n,
          unitAmountMinor: amount,
          amountMinor: amount,
          revenueAccount: ONE_TIME_ACCOUNT[component.category] ?? 'revenue.setup',
          calculation: {
            category: component.category,
            ...(licence !== null && {
              licence: licence.kind,
              sourceCodeIncluded: licence.sourceCodeIncluded,
              hostingIncludedMonths: licence.hostingIncludedMonths,
              maintenanceIncludedMonths: licence.maintenanceIncludedMonths,
            }),
          },
        });
        break;
      }
    }
  }

  // Discounts apply to the recurring lines of the components they name (never to one-time charges
  // unless named), each capped at what those lines charge, and never below zero overall.
  let remaining = lines.reduce((sum, line) => sum + line.amountMinor, 0n);
  for (const discount of input.discounts) {
    if (discount.invoices !== null && input.invoiceIndex >= discount.invoices) continue;
    const named = new Set(discount.appliesTo);
    const base = lines
      .filter((line) =>
        named.size === 0
          ? line.kind !== 'ONE_TIME' && line.kind !== 'DISCOUNT'
          : named.has(line.componentKey),
      )
      .filter((line) => line.kind !== 'DISCOUNT')
      .reduce((sum, line) => sum + line.amountMinor, 0n);
    const wanted = discount.kind === 'PERCENT' ? applyBps(base, discount.value) : BigInt(discount.value);
    const amount = minBig(minBig(wanted, base), remaining);
    if (amount <= 0n) continue;
    remaining -= amount;
    lines.push({
      kind: 'DISCOUNT',
      componentKey: discount.key,
      description: discount.label,
      quantity: 1n,
      unitAmountMinor: -amount,
      amountMinor: -amount,
      revenueAccount: 'revenue.discounts',
      calculation: {
        kind: discount.kind,
        value: discount.value,
        baseMinor: String(base),
        ...(discount.couponCode !== null && { couponCode: discount.couponCode }),
      },
    });
  }

  return totals(lines);
}

function pushMinimum(
  lines: PricedLine[],
  key: string,
  label: string,
  minimum: bigint,
  charged: bigint,
  account: RevenueAccount,
  proration: Record<string, number>,
): void {
  const topUp = minimum - charged;
  if (topUp <= 0n) return;
  lines.push({
    kind: 'MINIMUM_TOPUP',
    componentKey: key,
    description: `${label}: minimum charge`,
    quantity: 1n,
    unitAmountMinor: topUp,
    amountMinor: topUp,
    revenueAccount: account,
    calculation: { minimumMinor: String(minimum), chargedMinor: String(charged), ...proration },
  });
}

/** Subtotal: every charge; discount: every discount (positive); tax: none yet (PROPOSED 6). */
export function totals(lines: PricedLine[]): PricedInvoice {
  const subtotalMinor = lines.filter((l) => l.kind !== 'DISCOUNT').reduce((s, l) => s + l.amountMinor, 0n);
  const discountMinor = -lines.filter((l) => l.kind === 'DISCOUNT').reduce((s, l) => s + l.amountMinor, 0n);
  const taxMinor = 0n;
  return {
    lines,
    subtotalMinor,
    discountMinor,
    taxMinor,
    totalMinor: subtotalMinor - discountMinor + taxMinor,
  };
}
