/**
 * The subscription lifecycle (docs/design/saas-billing.md §10). Pure rules; the database enforces the
 * same transitions (migration 0016). A subscription is never suspended on a timer alone: dunning looks at
 * issued invoices that are unpaid past their due date, and only after the grace period.
 */
export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';

const TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  TRIALING: ['ACTIVE', 'PAST_DUE', 'CANCELLED'],
  ACTIVE: ['PAST_DUE', 'CANCELLED'],
  PAST_DUE: ['ACTIVE', 'SUSPENDED', 'CANCELLED'],
  SUSPENDED: ['ACTIVE', 'CANCELLED'],
  CANCELLED: [],
};

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

const DAY_MS = 86_400_000;

export interface DunningInput {
  status: SubscriptionStatus;
  /** Issued, unpaid invoices of the subscription. */
  unpaid: readonly { dueAt: Date }[];
  graceDays: number;
  now: Date;
}

/**
 * What the unpaid invoices call for, as the path of transitions to take (empty: nothing changes).
 * Past due once an invoice passes its due date; suspended once the oldest overdue one is `graceDays`
 * past due; back to active (or trialing stays) when nothing is overdue any more.
 */
export function dunningPath(input: DunningInput): SubscriptionStatus[] {
  if (input.status === 'CANCELLED') return [];
  const overdue = input.unpaid.filter((invoice) => invoice.dueAt.getTime() <= input.now.getTime());
  if (overdue.length === 0) {
    return input.status === 'PAST_DUE' || input.status === 'SUSPENDED' ? ['ACTIVE'] : [];
  }
  const oldest = Math.min(...overdue.map((invoice) => invoice.dueAt.getTime()));
  const suspendAt = oldest + input.graceDays * DAY_MS;
  if (input.now.getTime() >= suspendAt) {
    if (input.status === 'SUSPENDED') return [];
    return input.status === 'PAST_DUE' ? ['SUSPENDED'] : ['PAST_DUE', 'SUSPENDED'];
  }
  return input.status === 'ACTIVE' || input.status === 'TRIALING' ? ['PAST_DUE'] : [];
}

/** When the oldest overdue invoice would suspend the school (for notices); null when nothing is overdue. */
export function suspensionDate(
  unpaid: readonly { dueAt: Date }[],
  graceDays: number,
  now: Date,
): Date | null {
  const overdue = unpaid.filter((invoice) => invoice.dueAt.getTime() <= now.getTime());
  if (overdue.length === 0) return null;
  return new Date(Math.min(...overdue.map((invoice) => invoice.dueAt.getTime())) + graceDays * DAY_MS);
}

export type NoticeKind = 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE';

/**
 * Reminders for an issued invoice (PROPOSED): three days before it is due, on the due date, and the day
 * after. Only those still ahead of the issue time; each re-checks that the invoice is unpaid when sent.
 */
export function noticeTimes(issuedAt: Date, dueAt: Date): { kind: NoticeKind; at: Date }[] {
  const times: { kind: NoticeKind; at: Date }[] = [
    { kind: 'DUE_SOON', at: new Date(dueAt.getTime() - 3 * DAY_MS) },
    { kind: 'DUE_TODAY', at: dueAt },
    { kind: 'OVERDUE', at: new Date(dueAt.getTime() + DAY_MS) },
  ];
  return times.filter((time) => time.at.getTime() > issuedAt.getTime());
}
