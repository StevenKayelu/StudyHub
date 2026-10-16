import { Injectable } from '@nestjs/common';
import type { QueueSummary } from '@studyhub/contracts';

import type { TenantActor } from '../../identity';
import { TenantDb, type TenantTx } from '../../platform';
import { requireAdmin } from './guards';

/** F31 AC: items older than 72 hours are highlighted. */
export const OVERDUE_MS = 72 * 3600_000;

/**
 * Work queues (F31, S-AD01): count, oldest item and whether it is overdue, for the navigation badges and
 * the overview's queue cards.
 */
@Injectable()
export class QueuesService {
  constructor(private readonly db: TenantDb) {}

  async summary(actor: TenantActor): Promise<QueueSummary> {
    requireAdmin(actor);
    return this.db.run((tx) => queueSummary(tx, new Date()));
  }
}

export async function queueSummary(tx: TenantTx, now: Date): Promise<QueueSummary> {
  const entry = (
    key: QueueSummary['queues'][number]['key'],
    count: number,
    oldest: Date | null | undefined,
  ) => ({
    key,
    count,
    oldestAt: oldest?.toISOString() ?? null,
    overdue: oldest !== null && oldest !== undefined && now.getTime() - oldest.getTime() > OVERDUE_MS,
  });

  const applications = await tx.instructorProfile.aggregate({
    where: { status: 'SUBMITTED' },
    _count: { _all: true },
    _min: { submittedAt: true },
  });
  const reviews = await tx.courseSubmission.aggregate({
    where: { decision: null, course: { status: 'IN_REVIEW' } },
    _count: { _all: true },
    _min: { submittedAt: true },
  });
  const exceptions = await tx.payment.aggregate({
    where: { status: 'NEEDS_REVIEW' },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  const settlement = await tx.settlementItem.count({ where: { resolution: null } });
  const settlementOldest = await tx.settlementReport.findFirst({
    where: { items: { some: { resolution: null } } },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  const support = await tx.supportAccessGrant.aggregate({
    where: { status: 'REQUESTED' },
    _count: { _all: true },
    _min: { requestedAt: true },
  });
  return {
    queues: [
      entry('applications', applications._count._all, applications._min.submittedAt),
      entry('reviews', reviews._count._all, reviews._min.submittedAt),
      entry('paymentExceptions', exceptions._count._all, exceptions._min.createdAt),
      entry('settlement', settlement, settlementOldest?.createdAt),
      entry('supportAccess', support._count._all, support._min.requestedAt),
    ],
  };
}
