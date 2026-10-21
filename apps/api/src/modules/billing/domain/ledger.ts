import type { RevenueAccount } from './pricing';

/**
 * The platform ledger (docs/design/saas-billing.md §5.1): double-entry, append-only, integer minor
 * units with an explicit currency. A journal is one business event; its lines balance (debits equal
 * credits) in its currency. Mistakes are corrected by a reversing journal, never by editing one.
 * The database enforces the same rules (migration 0015); this module builds and checks journals first.
 */

export type AccountType = 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE' | 'SUSPENSE';

export interface AccountDefinition {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: 'DEBIT' | 'CREDIT';
  /** Lines on this account must name the school they concern. */
  perTenant: boolean;
}

/** The chart of accounts; the migration seeds the same rows. */
export const CHART: readonly AccountDefinition[] = [
  {
    code: 'cash.provider',
    name: 'Provider wallet (platform merchant)',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    perTenant: false,
  },
  {
    code: 'receivable.saas',
    name: 'SaaS invoices receivable',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    perTenant: true,
  },
  {
    code: 'settlement.in_transit',
    name: 'Settlements in transit',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    perTenant: true,
  },
  {
    code: 'unreconciled',
    name: 'Unreconciled transactions',
    type: 'SUSPENSE',
    normalBalance: 'DEBIT',
    perTenant: false,
  },
  {
    code: 'payable.tenant_funds',
    name: 'School funds payable',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    perTenant: true,
  },
  {
    code: 'liability.refunds',
    name: 'Refunds owed',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    perTenant: true,
  },
  {
    code: 'liability.tax',
    name: 'Tax payable',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    perTenant: false,
  },
  {
    code: 'revenue.licence',
    name: 'Licence revenue',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    perTenant: false,
  },
  {
    code: 'revenue.hosting',
    name: 'Hosting revenue',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    perTenant: false,
  },
  {
    code: 'revenue.maintenance',
    name: 'Maintenance revenue',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    perTenant: false,
  },
  {
    code: 'revenue.services',
    name: 'Other service revenue',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    perTenant: false,
  },
  {
    code: 'revenue.usage',
    name: 'Usage revenue (students)',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    perTenant: false,
  },
  {
    code: 'revenue.setup',
    name: 'Setup and one-time revenue',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    perTenant: false,
  },
  {
    code: 'revenue.commission',
    name: 'Commission revenue',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    perTenant: false,
  },
  {
    code: 'revenue.discounts',
    name: 'Discounts given (contra revenue)',
    type: 'REVENUE',
    normalBalance: 'DEBIT',
    perTenant: false,
  },
  {
    code: 'expense.provider_fees',
    name: 'Provider processing fees',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    perTenant: false,
  },
];
const ACCOUNTS = new Map(CHART.map((a) => [a.code, a]));

export interface JournalLine {
  account: string;
  /** The school the line concerns (required on per-tenant accounts; kept on revenue lines for reports). */
  tenantRef: string | null;
  debitMinor: bigint;
  creditMinor: bigint;
  memo: string;
}

export interface JournalDraft {
  kind: string;
  description: string;
  currency: string;
  /** What the journal records (e.g. `saas_invoice` + id); with `kind`, posted at most once. */
  sourceType: string;
  sourceId: string;
  lines: JournalLine[];
}

/** Throws unless the journal balances, has ≥ 2 lines, each one-sided and positive, on known accounts. */
export function assertBalanced(journal: JournalDraft): void {
  if (!/^[A-Z]{3}$/.test(journal.currency)) throw new RangeError('A journal needs a currency');
  if (journal.lines.length < 2) throw new RangeError('A journal needs at least two lines');
  let debits = 0n;
  let credits = 0n;
  for (const line of journal.lines) {
    const account = ACCOUNTS.get(line.account);
    if (account === undefined) throw new RangeError(`Unknown ledger account ${line.account}`);
    if (account.perTenant && line.tenantRef === null) {
      throw new RangeError(`Lines on ${line.account} must name a school`);
    }
    const oneSided =
      (line.debitMinor > 0n && line.creditMinor === 0n) || (line.creditMinor > 0n && line.debitMinor === 0n);
    if (!oneSided) throw new RangeError('Each line is either a positive debit or a positive credit');
    debits += line.debitMinor;
    credits += line.creditMinor;
  }
  if (debits !== credits) throw new RangeError(`Unbalanced journal: debits ${debits}, credits ${credits}`);
}

/** The reversing journal of `journal`: every debit becomes a credit and back. */
export function reversal(journal: JournalDraft, kind: string, description: string): JournalDraft {
  return {
    kind,
    description,
    currency: journal.currency,
    sourceType: journal.sourceType,
    sourceId: journal.sourceId,
    lines: journal.lines.map((line) => ({
      ...line,
      debitMinor: line.creditMinor,
      creditMinor: line.debitMinor,
    })),
  };
}

/**
 * Issuing a SaaS invoice (null when it charges nothing): the school owes the total (Dr receivable); each charge is revenue on its
 * account (Cr), discounts reduce revenue (Dr contra revenue), tax is owed to the authority (Cr).
 */
export function invoiceIssueJournal(invoice: {
  id: string;
  number: string;
  tenantRef: string;
  currency: string;
  totalMinor: bigint;
  taxMinor: bigint;
  lines: { revenueAccount: RevenueAccount; amountMinor: bigint }[];
}): JournalDraft | null {
  const lines: JournalLine[] = [];
  if (invoice.totalMinor > 0n) {
    lines.push({
      account: 'receivable.saas',
      tenantRef: invoice.tenantRef,
      debitMinor: invoice.totalMinor,
      creditMinor: 0n,
      memo: `Invoice ${invoice.number}`,
    });
  }
  // One line per revenue account keeps journals short and reports simple.
  const byAccount = new Map<RevenueAccount, bigint>();
  for (const line of invoice.lines) {
    byAccount.set(line.revenueAccount, (byAccount.get(line.revenueAccount) ?? 0n) + line.amountMinor);
  }
  for (const [account, amount] of byAccount) {
    if (amount === 0n) continue;
    lines.push({
      account,
      tenantRef: invoice.tenantRef,
      debitMinor: amount < 0n ? -amount : 0n,
      creditMinor: amount > 0n ? amount : 0n,
      memo: `Invoice ${invoice.number}`,
    });
  }
  if (invoice.taxMinor > 0n) {
    lines.push({
      account: 'liability.tax',
      tenantRef: invoice.tenantRef,
      debitMinor: 0n,
      creditMinor: invoice.taxMinor,
      memo: `Invoice ${invoice.number}: tax`,
    });
  }
  // An invoice with nothing on it (a trial without usage) moves no money: nothing to post.
  if (lines.length === 0) return null;
  const journal: JournalDraft = {
    kind: 'SAAS_INVOICE_ISSUED',
    description: `SaaS invoice ${invoice.number} issued`,
    currency: invoice.currency,
    sourceType: 'saas_invoice',
    sourceId: invoice.id,
    lines,
  };
  assertBalanced(journal);
  return journal;
}
