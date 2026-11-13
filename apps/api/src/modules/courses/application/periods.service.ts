import { Injectable } from '@nestjs/common';
import type { AdminPeriodList, PeriodKind, PeriodList, PeriodMode } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import { can, type TenantActor } from '../../identity';
import { periodLock } from '../../learning';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';

/** A current (not archived) period of this school, or a field error on `periodId`. */
export async function requirePeriod(tx: TenantTx, periodId: string): Promise<void> {
  const period = await tx.academicPeriod.findFirst({
    where: { id: periodId, archivedAt: null },
    select: { id: true },
  });
  if (period === null) {
    throw new AppError('VALIDATION_FAILED', {
      errors: [{ field: 'periodId', code: 'not_found', message: 'Choose a term' }],
    });
  }
}

const PERIOD_ORDER = [{ startsAt: 'asc' as const }, { name: 'asc' as const }];

/**
 * Terms, semesters and seminars (docs/design/course-periods.md). Administrators create them and
 * decide when they open; archived, never deleted, so courses keep their period.
 */
@Injectable()
export class PeriodsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** The school's current periods (catalogue filter, Studio picker). */
  async list(): Promise<PeriodList> {
    const periods = await this.db.run((tx) =>
      tx.academicPeriod.findMany({ where: { archivedAt: null }, orderBy: PERIOD_ORDER }),
    );
    const now = new Date();
    return {
      periods: periods.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        startsAt: p.startsAt.toISOString(),
        endsAt: p.endsAt?.toISOString() ?? null,
        open: periodLock(p, now) === null,
      })),
    };
  }

  async adminList(actor: TenantActor): Promise<AdminPeriodList> {
    requireAdmin(actor);
    const periods = await this.db.run((tx) =>
      tx.academicPeriod.findMany({
        orderBy: [{ archivedAt: { sort: 'desc', nulls: 'first' } }, ...PERIOD_ORDER],
        include: { _count: { select: { lessons: true } } },
      }),
    );
    const now = new Date();
    return {
      periods: periods.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        startsAt: p.startsAt.toISOString(),
        endsAt: p.endsAt?.toISOString() ?? null,
        mode: p.mode,
        open: periodLock(p, now) === null,
        archived: p.archivedAt !== null,
        lessonCount: p._count.lessons,
      })),
    };
  }

  async create(
    actor: TenantActor,
    input: {
      name: string;
      kind: PeriodKind;
      startsAt: string;
      endsAt?: string | null | undefined;
      mode?: PeriodMode | undefined;
    },
  ): Promise<{ id: string }> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const created = await tx.academicPeriod.create({
        data: {
          tenantId: requireTenantId(),
          name: input.name,
          kind: input.kind,
          startsAt: new Date(input.startsAt),
          endsAt: input.endsAt === undefined || input.endsAt === null ? null : new Date(input.endsAt),
          mode: input.mode ?? 'AUTO',
          position: await tx.academicPeriod.count(),
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'period.created',
        entityType: 'academic_period',
        entityId: created.id,
        actorId: actor.userId,
        after: input,
      });
      return created;
    });
  }

  /** Rename, change dates or kind, open or lock by hand (`mode`), archive or restore. */
  async update(
    actor: TenantActor,
    id: string,
    input: {
      name?: string | undefined;
      kind?: PeriodKind | undefined;
      startsAt?: string | undefined;
      endsAt?: string | null | undefined;
      mode?: PeriodMode | undefined;
      archived?: boolean | undefined;
    },
  ): Promise<void> {
    requireAdmin(actor);
    await this.db.run(async (tx) => {
      const period = await tx.academicPeriod.findFirst({ where: { id } });
      if (period === null) throw new AppError('NOT_FOUND');
      const startsAt = input.startsAt === undefined ? period.startsAt : new Date(input.startsAt);
      const endsAt =
        input.endsAt === undefined ? period.endsAt : input.endsAt === null ? null : new Date(input.endsAt);
      if (endsAt !== null && endsAt <= startsAt) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'endsAt', code: 'invalid', message: 'End after the start' }],
        });
      }
      await tx.academicPeriod.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.kind !== undefined && { kind: input.kind }),
          ...(input.mode !== undefined && { mode: input.mode }),
          ...(input.archived !== undefined && { archivedAt: input.archived ? new Date() : null }),
          startsAt,
          endsAt,
          updatedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        action: 'period.updated',
        entityType: 'academic_period',
        entityId: id,
        actorId: actor.userId,
        before: { name: period.name, mode: period.mode, startsAt: period.startsAt, endsAt: period.endsAt },
        after: input,
      });
    });
  }
}

function requireAdmin(actor: TenantActor): void {
  if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
}
