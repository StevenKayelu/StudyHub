import { Injectable } from '@nestjs/common';
import type { AuditEntry, AuditPage, AuditQuery } from '@studyhub/contracts';

import type { Prisma } from '../../../generated/prisma/client';
import type { TenantActor } from '../../identity';
import { TenantDb, type TenantTx } from '../../platform';
import { requireAdmin } from './guards';

const PAGE = 50;

/**
 * Audit entries with readable actors: a school member's name, a platform staff member's name from the
 * support grant (support sessions act as staff, F44), or the system (jobs, webhooks).
 */
export async function auditEntries(
  tx: TenantTx,
  query: { where: Prisma.AuditLogWhereInput; take?: number },
): Promise<{ entries: AuditEntry[]; nextBefore: string | null }> {
  const take = query.take ?? PAGE;
  const rows = await tx.auditLog.findMany({
    where: query.where,
    orderBy: { id: 'desc' },
    take: take + 1,
  });
  const page = rows.slice(0, take);
  const actorIds = [...new Set(page.map((r) => r.actorId).filter((id): id is string => id !== null))];
  const members =
    actorIds.length === 0
      ? []
      : await tx.userAccount.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, displayName: true },
        });
  const staff =
    actorIds.length === 0
      ? []
      : await tx.supportAccessGrant.findMany({
          where: { platformUserId: { in: actorIds } },
          distinct: ['platformUserId'],
          select: { platformUserId: true, staffDisplayName: true },
        });
  const memberNames = new Map(members.map((m) => [m.id, m.displayName]));
  const staffNames = new Map(staff.map((s) => [s.platformUserId, s.staffDisplayName]));
  return {
    entries: page.map((row) => {
      const member = row.actorId === null ? undefined : memberNames.get(row.actorId);
      const staffName = row.actorId === null ? undefined : staffNames.get(row.actorId);
      return {
        id: row.id.toString(),
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        actorName: member ?? (staffName === undefined ? null : `${staffName} (platform support)`),
        actorKind: member !== undefined ? 'MEMBER' : staffName !== undefined ? 'STAFF' : 'SYSTEM',
        before: row.before ?? null,
        after: row.after ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    }),
    nextBefore: rows.length > take ? (page[page.length - 1]?.id.toString() ?? null) : null,
  };
}

/** The school's audit log viewer (F34, F49; S-AD10): append-only, filters, before/after. */
@Injectable()
export class AuditLogService {
  constructor(private readonly db: TenantDb) {}

  async page(actor: TenantActor, query: AuditQuery): Promise<AuditPage> {
    requireAdmin(actor);
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action !== undefined && { action: { startsWith: query.action } }),
      ...(query.entityType !== undefined && { entityType: query.entityType }),
      ...(query.actorId !== undefined && { actorId: query.actorId }),
      ...(query.before !== undefined && { id: { lt: BigInt(query.before) } }),
      ...((query.from !== undefined || query.to !== undefined) && {
        createdAt: {
          ...(query.from !== undefined && { gte: new Date(`${query.from}T00:00:00Z`) }),
          ...(query.to !== undefined && { lt: new Date(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000) }),
        },
      }),
    };
    return this.db.run((tx) => auditEntries(tx, { where }));
  }
}
