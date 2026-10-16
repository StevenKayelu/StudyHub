import { Injectable } from '@nestjs/common';
import { DEFAULT_CONSOLE_SETTINGS, type SupportGrant } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import type { TenantActor } from '../../identity';
import { AppError, TenantDb, type TenantTx } from '../../platform';
import { requireAdmin, requireMember } from './guards';

type GrantRow = {
  id: string;
  staffDisplayName: string;
  reason: string;
  scope: SupportGrant['scope'];
  emergency: boolean;
  status: SupportGrant['status'];
  durationMinutes: number;
  requestedAt: Date;
  decidedAt: Date | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

/** APPROVED or ACTIVE grants past their end read as EXPIRED (F44 AC 1: they stop working at once). */
export function effectiveStatus(
  row: Pick<GrantRow, 'status' | 'expiresAt'>,
  now = new Date(),
): SupportGrant['status'] {
  if (
    (row.status === 'APPROVED' || row.status === 'ACTIVE') &&
    row.expiresAt !== null &&
    row.expiresAt <= now
  ) {
    return 'EXPIRED';
  }
  return row.status;
}

export function toGrant(row: GrantRow, now = new Date()): SupportGrant {
  return {
    id: row.id,
    staffName: row.staffDisplayName,
    reason: row.reason,
    scope: row.scope,
    emergency: row.emergency,
    status: effectiveStatus(row, now),
    durationMinutes: row.durationMinutes,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    startsAt: row.startsAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Support access as the school sees it (F44, S-AD16): requests to approve or deny, active grants to
 * revoke, history. Approval starts the time window; the console then opens the school.
 */
@Injectable()
export class SupportAccessService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(actor: TenantActor): Promise<{ grants: SupportGrant[] }> {
    requireAdmin(actor);
    const rows = await this.db.run((tx) =>
      tx.supportAccessGrant.findMany({ orderBy: { requestedAt: 'desc' }, take: 100 }),
    );
    return { grants: rows.map((row) => toGrant(row)) };
  }

  async decide(actor: TenantActor, grantId: string, approve: boolean): Promise<SupportGrant> {
    requireAdmin(actor);
    requireMember(actor);
    return this.db.run(async (tx) => {
      const grant = await this.grant(tx, grantId);
      if (grant.status !== 'REQUESTED') {
        throw new AppError('INVALID_STATE', { detail: 'This request was already decided.' });
      }
      const now = new Date();
      const maxMinutes = (await supportMaxHours(tx)) * 60;
      const minutes = Math.min(grant.durationMinutes, maxMinutes);
      const updated = await tx.supportAccessGrant.update({
        where: { id: grantId },
        data: approve
          ? {
              status: 'APPROVED',
              decidedBy: actor.membershipId,
              decidedAt: now,
              startsAt: now,
              expiresAt: new Date(now.getTime() + minutes * 60_000),
            }
          : { status: 'DENIED', decidedBy: actor.membershipId, decidedAt: now },
      });
      await this.audit.record(tx, {
        action: approve ? 'support.approved' : 'support.denied',
        entityType: 'support_access_grant',
        entityId: grantId,
        actorId: actor.userId,
        after: { scope: grant.scope, durationMinutes: approve ? minutes : null },
      });
      return toGrant(updated, now);
    });
  }

  /** F44 AC 2: a school admin can revoke an active grant; its sessions end on their next request. */
  async revoke(actor: TenantActor, grantId: string): Promise<SupportGrant> {
    requireAdmin(actor);
    requireMember(actor);
    return this.db.run(async (tx) => {
      const grant = await this.grant(tx, grantId);
      const status = effectiveStatus(grant);
      if (status !== 'APPROVED' && status !== 'ACTIVE') {
        throw new AppError('INVALID_STATE', { detail: 'Only approved or active access can be revoked.' });
      }
      const now = new Date();
      const updated = await tx.supportAccessGrant.update({
        where: { id: grantId },
        data: {
          status: 'REVOKED',
          revokedBy: actor.membershipId,
          revokedAt: now,
          handoffHash: null,
          handoffExpiresAt: null,
        },
      });
      await tx.supportSession.deleteMany({ where: { grantId } });
      await this.audit.record(tx, {
        action: 'support.revoked',
        entityType: 'support_access_grant',
        entityId: grantId,
        actorId: actor.userId,
      });
      return toGrant(updated, now);
    });
  }

  private async grant(tx: TenantTx, id: string) {
    const grant = await tx.supportAccessGrant.findFirst({ where: { id } });
    if (grant === null) throw new AppError('NOT_FOUND');
    return grant;
  }
}

/** BR-47: the longest grant, from the global settings (S-C08); 24 h by default. */
export async function supportMaxHours(tx: TenantTx): Promise<number> {
  const row = await tx.platformSetting.findUnique({ where: { key: 'supportMaxHours' } });
  const value = typeof row?.value === 'number' ? row.value : DEFAULT_CONSOLE_SETTINGS.supportMaxHours;
  return Math.min(Math.max(Math.floor(value), 1), 24);
}
