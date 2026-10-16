import { Injectable } from '@nestjs/common';
import type { ReportOverview, ReportQuery } from '@studyhub/contracts';

import type { TenantActor } from '../../identity';
import { TenantDb } from '../../platform';
import { requireAdmin } from './guards';
import { bucketStart, buckets, dayRange, refundsTotal, salesTotal } from './report-queries';

/** Admin dashboard (F32, S-AD01, S-AD07): revenue, learners, enrolments, top courses, payment success. */
@Injectable()
export class ReportsService {
  constructor(private readonly db: TenantDb) {}

  async overview(actor: TenantActor, query: ReportQuery): Promise<ReportOverview> {
    requireAdmin(actor);
    const range = dayRange(query.from, query.to);
    return this.db.run(async (tx) => {
      const sales = await salesTotal(tx, range);
      const refunds = await refundsTotal(tx, range);
      const tenant = await tx.tenant.findFirst({ select: { currency: true } });

      const series = new Map(
        buckets(range, query.interval).map((period) => [
          period,
          { period, gross: 0, refunds: 0, net: 0, enrolments: 0, newLearners: 0 },
        ]),
      );
      const bump = (at: Date, key: 'gross' | 'refunds' | 'enrolments' | 'newLearners', amount: number) => {
        const entry = series.get(bucketStart(at, query.interval));
        if (entry !== undefined) entry[key] += amount;
      };
      const payments = await tx.payment.findMany({
        where: {
          status: { in: ['SUCCEEDED', 'REFUNDED'] },
          confirmedAt: { gte: range.start, lt: range.end },
        },
        select: { confirmedAt: true, amountMinor: true },
      });
      for (const p of payments) bump(p.confirmedAt!, 'gross', Number(p.amountMinor));
      const refundRows = await tx.refund.findMany({
        where: { status: 'SUCCEEDED', completedAt: { gte: range.start, lt: range.end } },
        select: { completedAt: true, amountMinor: true },
      });
      for (const r of refundRows) bump(r.completedAt!, 'refunds', Number(r.amountMinor));
      const enrolments = await tx.enrollment.findMany({
        where: { startedAt: { gte: range.start, lt: range.end } },
        select: { startedAt: true, courseId: true },
      });
      for (const e of enrolments) bump(e.startedAt, 'enrolments', 1);
      const joined = await tx.tenantMembership.findMany({
        where: { joinedAt: { gte: range.start, lt: range.end } },
        select: { joinedAt: true },
      });
      for (const m of joined) bump(m.joinedAt!, 'newLearners', 1);
      for (const entry of series.values()) entry.net = entry.gross - entry.refunds;

      const top = await tx.$queryRaw<
        { course_id: string; title: string; enrolments: bigint; revenue: bigint | null }[]
      >`
        SELECT c.id AS course_id, c.title,
               count(e.id)::bigint AS enrolments,
               (SELECT sum(p.amount_minor)::bigint FROM payment p JOIN order_item oi
                   ON oi.tenant_id = p.tenant_id AND oi.order_id = p.order_id
                 WHERE oi.course_id = c.id AND p.status IN ('SUCCEEDED', 'REFUNDED')
                   AND p.confirmed_at >= ${range.start} AND p.confirmed_at < ${range.end}) AS revenue
          FROM enrollment e JOIN course c ON c.tenant_id = e.tenant_id AND c.id = e.course_id
         WHERE e.started_at >= ${range.start} AND e.started_at < ${range.end}
         GROUP BY c.id, c.title
         ORDER BY count(e.id) DESC, c.title
         LIMIT 5`;
      const methods = await tx.$queryRaw<
        { method: 'MOBILE_MONEY' | 'CARD'; attempted: bigint; succeeded: bigint }[]
      >`
        SELECT method::text AS method, count(*)::bigint AS attempted,
               count(*) FILTER (WHERE status IN ('SUCCEEDED', 'REFUNDED'))::bigint AS succeeded
          FROM payment WHERE created_at >= ${range.start} AND created_at < ${range.end}
         GROUP BY method ORDER BY method`;

      return {
        from: query.from,
        to: query.to,
        interval: query.interval,
        currency: tenant?.currency ?? 'ZMW',
        revenue: {
          gross: Number(sales.gross),
          refunds: Number(refunds),
          net: Number(sales.gross - refunds),
          orders: sales.count,
        },
        newLearners: joined.length,
        enrolments: enrolments.length,
        series: [...series.values()],
        topCourses: top.map((row) => ({
          courseId: row.course_id,
          title: row.title,
          enrolments: Number(row.enrolments),
          revenueMinor: Number(row.revenue ?? 0n),
        })),
        paymentSuccess: methods.map((row) => ({
          method: row.method,
          attempted: Number(row.attempted),
          succeeded: Number(row.succeeded),
          rate:
            row.attempted === 0n
              ? null
              : Math.round((Number(row.succeeded) / Number(row.attempted)) * 1000) / 10,
        })),
      };
    });
  }
}
