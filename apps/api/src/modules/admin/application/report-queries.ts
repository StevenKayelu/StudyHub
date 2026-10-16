import type { TenantTx } from '../../platform';

/**
 * One definition of each figure, shared by the dashboard, the CSV exports and the platform statements
 * (F32 AC: dashboard totals equal export totals; W8: statements use recorded sales). Ranges are whole
 * UTC days, `to` inclusive (M9 PROPOSED: the school's time zone is a later refinement).
 *
 * - Sales (gross): payments that SUCCEEDED (or were later REFUNDED), by confirmation time.
 * - Refunds: refunds that SUCCEEDED, by completion time.
 * - Enrolments: enrolments started in the range (any source).
 * - New learners: memberships that joined in the range.
 */
export interface DayRange {
  start: Date;
  /** Exclusive. */
  end: Date;
}

export function dayRange(from: string, to: string): DayRange {
  return {
    start: new Date(`${from}T00:00:00.000Z`),
    end: new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000),
  };
}

export function monthRange(period: string): DayRange {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

export const SALE_STATUSES = ['SUCCEEDED', 'REFUNDED'] as const;

export async function salesTotal(tx: TenantTx, range: DayRange): Promise<{ gross: bigint; count: number }> {
  const [row] = await tx.$queryRaw<{ gross: bigint | null; count: bigint }[]>`
    SELECT sum(amount_minor)::bigint AS gross, count(*)::bigint AS count FROM payment
     WHERE status IN ('SUCCEEDED', 'REFUNDED') AND confirmed_at >= ${range.start} AND confirmed_at < ${range.end}`;
  return { gross: row?.gross ?? 0n, count: Number(row?.count ?? 0n) };
}

export async function refundsTotal(tx: TenantTx, range: DayRange): Promise<bigint> {
  const [row] = await tx.$queryRaw<{ total: bigint | null }[]>`
    SELECT sum(amount_minor)::bigint AS total FROM refund
     WHERE status = 'SUCCEEDED' AND completed_at >= ${range.start} AND completed_at < ${range.end}`;
  return row?.total ?? 0n;
}

export type Interval = 'day' | 'week' | 'month';

/** Start of the bucket a date falls in (weeks start on Monday). */
export function bucketStart(date: Date, interval: Interval): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (interval === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (interval === 'month') d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}

/** Every bucket from the range start to its end, so empty periods show as zero. */
export function buckets(range: DayRange, interval: Interval): string[] {
  const out: string[] = [];
  let cursor = new Date(`${bucketStart(range.start, interval)}T00:00:00Z`);
  while (cursor < range.end) {
    out.push(cursor.toISOString().slice(0, 10));
    const next = new Date(cursor);
    if (interval === 'day') next.setUTCDate(next.getUTCDate() + 1);
    else if (interval === 'week') next.setUTCDate(next.getUTCDate() + 7);
    else next.setUTCMonth(next.getUTCMonth() + 1);
    cursor = next;
  }
  return out;
}
