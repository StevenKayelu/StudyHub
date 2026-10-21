import { type Discount, type PlanComponent, planComponentSchema } from '@studyhub/contracts';
import { describe, expect, it } from 'vitest';

import { assertBalanced, invoiceIssueJournal, reversal } from './ledger';
import { mergeComponents, type PricingInput, priceInvoice } from './pricing';

const component = (value: Record<string, unknown>): PlanComponent => planComponentSchema.parse(value);
const discount = (value: Partial<Discount> & Pick<Discount, 'key' | 'kind' | 'value'>): Discount => ({
  label: 'Discount',
  appliesTo: [],
  invoices: null,
  couponCode: null,
  ...value,
});
const none = { grossMinor: 0n, refundsMinor: 0n, providerFeesMinor: 0n, transactions: 0 };
const JANUARY = { start: '2027-01-01', end: '2027-02-01' };

function input(overrides: Partial<PricingInput>): PricingInput {
  return {
    components: [],
    enabledAddons: [],
    discounts: [],
    period: JANUARY,
    cycle: JANUARY,
    invoiceIndex: 1,
    includeOneTime: false,
    chargeRecurring: true,
    students: { ACTIVE_LEARNERS: 0, ENROLLED_LEARNERS: 0 },
    revenue: { FULL: none, DEPOSIT: none, BALANCE: none },
    ...overrides,
  };
}
const amounts = (invoice: ReturnType<typeof priceInvoice>) =>
  invoice.lines.map((line) => [line.kind, line.componentKey, line.amountMinor]);

const licence = component({
  type: 'FIXED',
  key: 'licence',
  label: 'Licence',
  category: 'LICENCE',
  amountMinor: 50_000,
});
const hosting = component({
  type: 'FIXED',
  key: 'hosting',
  label: 'Hosting',
  category: 'HOSTING',
  amountMinor: 20_000,
});

describe('fixed subscription', () => {
  it('charges each fixed component per cycle, on its own revenue account', () => {
    const invoice = priceInvoice(input({ components: [licence, hosting] }));
    expect(amounts(invoice)).toEqual([
      ['LICENCE', 'licence', 50_000n],
      ['HOSTING', 'hosting', 20_000n],
    ]);
    expect(invoice.lines.map((l) => l.revenueAccount)).toEqual(['revenue.licence', 'revenue.hosting']);
    expect(invoice.totalMinor).toBe(70_000n);
  });

  it('prorates a partial first period by days, rounding half up', () => {
    // 12 of 31 days of 500.00: 193.548… → 193.55
    const invoice = priceInvoice(
      input({ components: [licence], period: { start: '2027-01-20', end: '2027-02-01' } }),
    );
    expect(invoice.totalMinor).toBe(19_355n);
    expect(invoice.lines[0]!.calculation).toMatchObject({ periodDays: 12, cycleDays: 31 });
  });

  it('bills add-ons only when the contract enables them', () => {
    const sms = component({
      type: 'FIXED',
      key: 'sms',
      label: 'SMS',
      category: 'MESSAGING',
      amountMinor: 3_000,
      optional: true,
    });
    expect(priceInvoice(input({ components: [licence, sms] })).totalMinor).toBe(50_000n);
    const enabled = priceInvoice(input({ components: [licence, sms], enabledAddons: ['sms'] }));
    expect(enabled.lines[1]).toMatchObject({
      kind: 'SERVICE',
      revenueAccount: 'revenue.services',
      amountMinor: 3_000n,
    });
  });

  it('charges no recurring fee during a trial', () => {
    expect(priceInvoice(input({ components: [licence], chargeRecurring: false })).lines).toEqual([]);
  });
});

describe('per-student billing', () => {
  const perStudent = component({
    type: 'PER_STUDENT',
    key: 'students',
    label: 'Students',
    billableRule: 'ENROLLED_LEARNERS',
    unitAmountMinor: 1_000,
    includedStudents: 20,
    overageThreshold: 100,
    overageUnitAmountMinor: 1_500,
    minimumMinor: 30_000,
  });

  it('charges students above the allowance, then the overage rate above the threshold', () => {
    const invoice = priceInvoice(
      input({ components: [perStudent], students: { ACTIVE_LEARNERS: 999, ENROLLED_LEARNERS: 130 } }),
    );
    expect(amounts(invoice)).toEqual([
      ['PER_STUDENT', 'students', 80_000n], // 21–100: 80 × 10.00
      ['OVERAGE', 'students', 45_000n], // 101–130: 30 × 15.00
    ]);
    expect(invoice.lines[0]!.calculation).toMatchObject({ rule: 'ENROLLED_LEARNERS', students: 130 });
  });

  it('tops up to the minimum, prorated for a partial period', () => {
    const small = priceInvoice(
      input({ components: [perStudent], students: { ACTIVE_LEARNERS: 0, ENROLLED_LEARNERS: 25 } }),
    );
    expect(amounts(small)).toEqual([
      ['PER_STUDENT', 'students', 5_000n],
      ['MINIMUM_TOPUP', 'students', 25_000n],
    ]);
    const partial = priceInvoice(
      input({
        components: [perStudent],
        period: { start: '2027-01-17', end: '2027-02-01' },
        students: { ACTIVE_LEARNERS: 0, ENROLLED_LEARNERS: 0 },
      }),
    );
    // 15 of 31 days of 300.00 = 145.16
    expect(amounts(partial)).toEqual([['MINIMUM_TOPUP', 'students', 14_516n]]);
  });

  it('includes everyone below the allowance at no charge (and no lines when there is no minimum)', () => {
    const free = component({
      type: 'PER_STUDENT',
      key: 'students',
      label: 'Students',
      billableRule: 'ACTIVE_LEARNERS',
      unitAmountMinor: 1_000,
      includedStudents: 50,
    });
    expect(
      priceInvoice(input({ components: [free], students: { ACTIVE_LEARNERS: 50, ENROLLED_LEARNERS: 0 } }))
        .lines,
    ).toEqual([]);
  });
});

describe('revenue share', () => {
  const share = component({
    type: 'REVENUE_SHARE',
    key: 'share',
    label: 'Commission',
    bps: 750,
    fixedFeePerTransactionMinor: 50,
    minimumMinor: 10_000,
    eligibleParts: ['FULL', 'DEPOSIT'],
  });
  const revenue = {
    FULL: { grossMinor: 1_000_000n, refundsMinor: 100_000n, providerFeesMinor: 30_000n, transactions: 40 },
    DEPOSIT: { grossMinor: 200_000n, refundsMinor: 0n, providerFeesMinor: 6_000n, transactions: 10 },
    BALANCE: { grossMinor: 999_999n, refundsMinor: 0n, providerFeesMinor: 0n, transactions: 99 },
  };

  it('charges the percentage of eligible collections net of refunds, plus a per-transaction fee', () => {
    const invoice = priceInvoice(input({ components: [share], revenue }));
    // (1 200 000 − 100 000) × 7.5 % = 82 500; 50 transactions × 0.50 = 2 500. BALANCE is not eligible.
    expect(amounts(invoice)).toEqual([
      ['REVENUE_SHARE', 'share', 82_500n],
      ['TRANSACTION_FEE', 'share', 2_500n],
    ]);
    expect(invoice.lines[0]!.calculation).toMatchObject({
      baseMinor: '1100000',
      refundsMinor: '100000',
      bps: 750,
    });
  });

  it('can also deduct provider fees, never lets refunds push the base below zero, and keeps the minimum', () => {
    const withFees = component({ ...share, providerFeesReduceBase: true });
    expect(priceInvoice(input({ components: [withFees], revenue })).lines[0]!.amountMinor).toBe(79_800n);
    const refundHeavy = {
      FULL: { grossMinor: 10_000n, refundsMinor: 50_000n, providerFeesMinor: 0n, transactions: 0 },
      DEPOSIT: none,
      BALANCE: none,
    };
    expect(amounts(priceInvoice(input({ components: [share], revenue: refundHeavy })))).toEqual([
      ['MINIMUM_TOPUP', 'share', 10_000n],
    ]);
  });

  it('is earned during a trial (only recurring fees are waived)', () => {
    const invoice = priceInvoice(input({ components: [licence, share], revenue, chargeRecurring: false }));
    expect(invoice.lines.map((l) => l.kind)).toEqual(['REVENUE_SHARE', 'TRANSACTION_FEE']);
  });
});

describe('one-time charges, hybrid plans and contracts', () => {
  const setup = component({
    type: 'ONE_TIME',
    key: 'setup',
    label: 'Onboarding',
    category: 'SETUP',
    amountMinor: 150_000,
  });
  const perpetual = component({
    type: 'ONE_TIME',
    key: 'perpetual',
    label: 'Licence',
    category: 'LICENCE',
    amountMinor: 2_000_000,
    licence: { kind: 'PERPETUAL_USE' },
  });

  it('bills one-time charges on the first invoice only, and states licence terms explicitly', () => {
    expect(priceInvoice(input({ components: [setup, perpetual], includeOneTime: false })).lines).toEqual([]);
    const first = priceInvoice(input({ components: [setup, perpetual], includeOneTime: true }));
    expect(first.lines.map((l) => l.revenueAccount)).toEqual(['revenue.setup', 'revenue.licence']);
    expect(first.lines[1]!.calculation).toMatchObject({
      licence: 'PERPETUAL_USE',
      sourceCodeIncluded: false,
      hostingIncludedMonths: 0,
      maintenanceIncludedMonths: 0,
    });
  });

  it('prices a hybrid plan: licence, per student, revenue share, hosting, maintenance and setup', () => {
    const maintenance = component({
      type: 'FIXED',
      key: 'maintenance',
      label: 'Maintenance',
      category: 'MAINTENANCE',
      amountMinor: 10_000,
    });
    const perStudent = component({
      type: 'PER_STUDENT',
      key: 'students',
      label: 'Students',
      billableRule: 'ACTIVE_LEARNERS',
      unitAmountMinor: 500,
    });
    const share = component({
      type: 'REVENUE_SHARE',
      key: 'share',
      label: 'Commission',
      bps: 300,
      eligibleParts: ['FULL'],
    });
    const invoice = priceInvoice(
      input({
        components: [licence, hosting, maintenance, perStudent, share, setup],
        includeOneTime: true,
        students: { ACTIVE_LEARNERS: 40, ENROLLED_LEARNERS: 0 },
        revenue: {
          FULL: { grossMinor: 500_000n, refundsMinor: 0n, providerFeesMinor: 0n, transactions: 5 },
          DEPOSIT: none,
          BALANCE: none,
        },
      }),
    );
    expect(invoice.totalMinor).toBe(50_000n + 20_000n + 10_000n + 20_000n + 15_000n + 150_000n);
  });

  it('lets a contract replace a plan component or add a new one', () => {
    const negotiated = component({
      type: 'FIXED',
      key: 'licence',
      label: 'Licence (negotiated)',
      category: 'LICENCE',
      amountMinor: 40_000,
    });
    const extra = component({
      type: 'FIXED',
      key: 'support',
      label: 'Priority support',
      category: 'SERVICE',
      amountMinor: 5_000,
    });
    const merged = mergeComponents([licence, hosting], [negotiated, extra]);
    expect(merged.map((c) => [c.key, c.type === 'FIXED' ? c.amountMinor : 0])).toEqual([
      ['licence', 40_000],
      ['hosting', 20_000],
      ['support', 5_000],
    ]);
  });
});

describe('discounts', () => {
  it('applies a percentage to recurring components, never to one-time charges unless named', () => {
    const setup = component({
      type: 'ONE_TIME',
      key: 'setup',
      label: 'Setup',
      category: 'SETUP',
      amountMinor: 100_000,
    });
    const invoice = priceInvoice(
      input({
        components: [licence, setup],
        includeOneTime: true,
        discounts: [discount({ key: 'launch', kind: 'PERCENT', value: 2_000 })],
      }),
    );
    expect(invoice.discountMinor).toBe(10_000n);
    expect(invoice.totalMinor).toBe(140_000n);
    expect(invoice.lines.at(-1)).toMatchObject({
      kind: 'DISCOUNT',
      revenueAccount: 'revenue.discounts',
      amountMinor: -10_000n,
    });
  });

  it('caps fixed discounts at what they apply to, stops after N invoices, and never goes below zero', () => {
    const big = discount({ key: 'big', kind: 'AMOUNT', value: 999_999, appliesTo: ['hosting'] });
    expect(priceInvoice(input({ components: [licence, hosting], discounts: [big] })).discountMinor).toBe(
      20_000n,
    );
    const firstTwo = discount({ key: 'intro', kind: 'PERCENT', value: 10_000, invoices: 2 });
    expect(
      priceInvoice(input({ components: [licence], discounts: [firstTwo], invoiceIndex: 1 })).totalMinor,
    ).toBe(0n);
    expect(
      priceInvoice(input({ components: [licence], discounts: [firstTwo], invoiceIndex: 2 })).totalMinor,
    ).toBe(50_000n);
    const twoFull = [
      discount({ key: 'a', kind: 'PERCENT', value: 10_000 }),
      discount({ key: 'b', kind: 'AMOUNT', value: 5_000 }),
    ];
    const stacked = priceInvoice(input({ components: [licence], discounts: twoFull }));
    expect(stacked.totalMinor).toBe(0n);
    expect(stacked.lines.filter((l) => l.kind === 'DISCOUNT')).toHaveLength(1);
  });
});

describe('the platform ledger', () => {
  it('posts an issued invoice as a balanced journal by revenue account', () => {
    const invoice = priceInvoice(
      input({
        components: [licence, hosting],
        discounts: [discount({ key: 'd', kind: 'AMOUNT', value: 1_000 })],
      }),
    );
    const journal = invoiceIssueJournal({
      id: 'inv',
      number: 'SH-2027-000001',
      tenantRef: 'school',
      currency: 'ZMW',
      totalMinor: invoice.totalMinor,
      taxMinor: invoice.taxMinor,
      lines: invoice.lines,
    })!;
    expect(journal.lines.map((l) => [l.account, l.debitMinor, l.creditMinor])).toEqual([
      ['receivable.saas', 69_000n, 0n],
      ['revenue.licence', 0n, 50_000n],
      ['revenue.hosting', 0n, 20_000n],
      ['revenue.discounts', 1_000n, 0n],
    ]);
    const reversed = reversal(journal, 'SAAS_INVOICE_VOIDED', 'void');
    expect(() => assertBalanced(reversed)).not.toThrow();
    expect(reversed.lines[0]).toMatchObject({ debitMinor: 0n, creditMinor: 69_000n });
  });

  it('posts nothing for an empty invoice and refuses unbalanced or anonymous journals', () => {
    expect(
      invoiceIssueJournal({
        id: 'i',
        number: 'n',
        tenantRef: 't',
        currency: 'ZMW',
        totalMinor: 0n,
        taxMinor: 0n,
        lines: [],
      }),
    ).toBeNull();
    const base = { kind: 'X', description: 'x', currency: 'ZMW', sourceType: 's', sourceId: 'i' };
    expect(() =>
      assertBalanced({
        ...base,
        lines: [
          { account: 'cash.provider', tenantRef: null, debitMinor: 100n, creditMinor: 0n, memo: '' },
          { account: 'revenue.services', tenantRef: null, debitMinor: 0n, creditMinor: 99n, memo: '' },
        ],
      }),
    ).toThrow('Unbalanced');
    expect(() =>
      assertBalanced({
        ...base,
        lines: [
          { account: 'receivable.saas', tenantRef: null, debitMinor: 100n, creditMinor: 0n, memo: '' },
          { account: 'revenue.services', tenantRef: null, debitMinor: 0n, creditMinor: 100n, memo: '' },
        ],
      }),
    ).toThrow('must name a school');
  });
});
