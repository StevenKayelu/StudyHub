import type { BillableStudentRule } from '@studyhub/contracts';

import type { TenantTx } from '../../platform';
import type { RevenueFigures } from '../domain/pricing';
import type { Span } from '../domain/periods';

/** Version of the counting rules below, recorded on each snapshot so old invoices stay explainable. */
export const USAGE_RULES_VERSION = 1;

export type Parts = Record<'FULL' | 'DEPOSIT' | 'BALANCE', RevenueFigures>;

export interface UsageFigures {
  students: Record<BillableStudentRule, number>;
  /** Eligible education collections by currency, then by order-item part. */
  revenue: Record<string, Parts>;
}

const day = (value: string) => new Date(`${value}T00:00:00Z`);

/**
 * Counts a school's billable usage for a span, inside that school (the caller runs this in a platform
 * transaction scoped to the school). Only totals leave the school.
 *
 * - ACTIVE_LEARNERS: memberships with the learner role, active when counted, that joined before the
 *   span ended (status is current, not historical: snapshots are taken when the period closes).
 * - ENROLLED_LEARNERS: distinct members with an enrolment that was active at any time in the span.
 * - Revenue: payments confirmed in the span (succeeded or later refunded) by order-item part; refunds
 *   completed in the span by the part of the payment they refund; provider fees where reported.
 */
export async function measureUsage(tx: TenantTx, span: Span): Promise<UsageFigures> {
  const start = day(span.start);
  const end = day(span.end);
  const [active] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(DISTINCT m.id)::bigint AS n
      FROM tenant_membership m JOIN membership_role r ON r.tenant_id = m.tenant_id AND r.membership_id = m.id
     WHERE r.role = 'LEARNER' AND m.status = 'ACTIVE' AND coalesce(m.joined_at, m.created_at) < ${end}`;
  const [enrolled] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(DISTINCT e.membership_id)::bigint AS n FROM enrollment e
     WHERE e.started_at < ${end}
       AND (e.status = 'ACTIVE' OR coalesce(e.revoked_at, e.expires_at, e.updated_at) >= ${start})`;
  const payments = await tx.$queryRaw<
    { currency: string; part: string; gross: bigint; fees: bigint; n: bigint }[]
  >`
    SELECT p.currency, oi.part::text AS part, sum(p.amount_minor)::bigint AS gross,
           coalesce(sum(p.provider_fee_minor), 0)::bigint AS fees, count(*)::bigint AS n
      FROM payment p JOIN order_item oi ON oi.tenant_id = p.tenant_id AND oi.order_id = p.order_id
     WHERE p.status IN ('SUCCEEDED', 'REFUNDED') AND p.confirmed_at >= ${start} AND p.confirmed_at < ${end}
     GROUP BY p.currency, oi.part`;
  const refunds = await tx.$queryRaw<{ currency: string; part: string; total: bigint }[]>`
    SELECT r.currency, oi.part::text AS part, sum(r.amount_minor)::bigint AS total
      FROM refund r JOIN order_item oi ON oi.tenant_id = r.tenant_id AND oi.order_id = r.order_id
     WHERE r.status = 'SUCCEEDED' AND r.completed_at >= ${start} AND r.completed_at < ${end}
     GROUP BY r.currency, oi.part`;

  const revenue: Record<string, Parts> = {};
  const parts = (currency: string): Parts =>
    (revenue[currency] ??= {
      FULL: emptyFigures(),
      DEPOSIT: emptyFigures(),
      BALANCE: emptyFigures(),
    });
  for (const row of payments) {
    const figures = parts(row.currency)[row.part as keyof Parts];
    figures.grossMinor += row.gross;
    figures.providerFeesMinor += row.fees;
    figures.transactions += Number(row.n);
  }
  for (const row of refunds) parts(row.currency)[row.part as keyof Parts].refundsMinor += row.total;
  return {
    students: { ACTIVE_LEARNERS: Number(active?.n ?? 0n), ENROLLED_LEARNERS: Number(enrolled?.n ?? 0n) },
    revenue,
  };
}

export function emptyFigures(): RevenueFigures {
  return { grossMinor: 0n, refundsMinor: 0n, providerFeesMinor: 0n, transactions: 0 };
}

/** JSON-safe forms for the snapshot row (bigints as strings), and back. */
export function revenueToJson(revenue: Record<string, Parts>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(revenue).map(([currency, byPart]) => [
      currency,
      Object.fromEntries(
        Object.entries(byPart).map(([part, f]) => [
          part,
          {
            grossMinor: f.grossMinor.toString(),
            refundsMinor: f.refundsMinor.toString(),
            providerFeesMinor: f.providerFeesMinor.toString(),
            transactions: f.transactions,
          },
        ]),
      ),
    ]),
  );
}

export function revenueFromJson(json: unknown, currency: string): Parts {
  const byPart = ((json ?? {}) as Record<string, Record<string, Record<string, string | number>>>)[currency];
  const read = (part: keyof Parts): RevenueFigures => {
    const f = byPart?.[part];
    return f === undefined
      ? emptyFigures()
      : {
          grossMinor: BigInt(f.grossMinor ?? 0),
          refundsMinor: BigInt(f.refundsMinor ?? 0),
          providerFeesMinor: BigInt(f.providerFeesMinor ?? 0),
          transactions: Number(f.transactions ?? 0),
        };
  };
  return { FULL: read('FULL'), DEPOSIT: read('DEPOSIT'), BALANCE: read('BALANCE') };
}
