import { Injectable } from '@nestjs/common';
import type { ConsoleSupportGrant } from '@studyhub/contracts';

import { effectiveStatus, supportMaxHours, toGrant } from '../../admin';
import {
  AppError,
  ConfigService,
  issueToken,
  queueEmail,
  SecretBox,
  TenantDb,
  type TenantTx,
} from '../../platform';
import type { ConsoleActor } from './console-auth.service';
import { recordInSchool, recordPlatform } from './platform-audit';

/** 04 §17.12: the "Open school" hand-off works once, for 60 seconds. */
const HANDOFF_TTL_MS = 60_000;

/**
 * Support access from the console (F44, BR-47): staff request time-limited access with a reason and
 * scope; the school approves in its admin area (S-AD16); emergency access (platform owner, after
 * re-authentication) starts at once and the school's owners are told immediately. Staff open an active
 * grant through a one-time hand-off to the school host.
 */
@Injectable()
export class ConsoleSupportService {
  constructor(
    private readonly db: TenantDb,
    private readonly config: ConfigService,
    private readonly box: SecretBox,
  ) {}

  async list(actor: ConsoleActor, tenantId?: string): Promise<{ grants: ConsoleSupportGrant[] }> {
    return this.db.runPlatform(async (tx) => {
      const grants = await tx.supportAccessGrant.findMany({
        where: {
          ...(tenantId !== undefined && { tenantId }),
          // Support staff see their own grants; owners and operators see all.
          ...(actor.role === 'PLATFORM_SUPPORT' && { platformUserId: actor.userId }),
        },
        orderBy: { requestedAt: 'desc' },
        take: 200,
      });
      const tenants = await tx.tenant.findMany({
        where: { id: { in: [...new Set(grants.map((g) => g.tenantId))] } },
        select: { id: true, name: true },
      });
      const names = new Map(tenants.map((t) => [t.id, t.name]));
      return {
        grants: grants.map((g) => ({
          ...toGrant(g),
          tenantId: g.tenantId,
          tenantName: names.get(g.tenantId) ?? '',
          staffId: g.platformUserId,
        })),
      };
    });
  }

  async request(
    actor: ConsoleActor,
    input: { tenantId: string; reason: string; scope: 'READ_ONLY' | 'READ_WRITE'; durationMinutes: number },
    emergency = false,
  ): Promise<{ id: string; status: string }> {
    const tenant = await this.db.runPlatform((tx) =>
      tx.tenant.findUnique({
        where: { id: input.tenantId },
        select: {
          name: true,
          status: true,
          domains: { where: { isPrimary: true }, select: { hostname: true } },
        },
      }),
    );
    if (tenant === null || tenant.status === 'DELETED') throw new AppError('NOT_FOUND');
    return this.db.runPlatformIn(input.tenantId, async (tx) => {
      const maxMinutes = (await supportMaxHours(tx)) * 60;
      if (input.durationMinutes > maxMinutes) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [
            {
              field: 'durationMinutes',
              code: 'too_long',
              message: `Access can last at most ${maxMinutes / 60} hours`,
            },
          ],
        });
      }
      const now = new Date();
      const grant = await tx.supportAccessGrant.create({
        data: {
          tenantId: input.tenantId,
          platformUserId: actor.userId,
          staffDisplayName: actor.displayName,
          reason: input.reason,
          scope: input.scope,
          emergency,
          durationMinutes: input.durationMinutes,
          ...(emergency && {
            status: 'APPROVED' as const,
            decidedAt: now,
            startsAt: now,
            expiresAt: new Date(now.getTime() + input.durationMinutes * 60_000),
          }),
        },
        select: { id: true, status: true },
      });
      const entry = {
        actorId: actor.userId,
        action: emergency ? 'support.emergency_started' : 'support.requested',
        entityType: 'support_access_grant',
        entityId: grant.id,
        tenantRef: input.tenantId,
        after: { scope: input.scope, durationMinutes: input.durationMinutes, reason: input.reason },
      };
      await recordPlatform(tx, entry);
      // The school sees requests in its own log too (F44: every action is in both logs).
      await recordInSchool(tx, input.tenantId, entry);
      await this.notifySchool(tx, tenant.name, tenant.domains[0]?.hostname ?? null, input.reason, emergency);
      return grant;
    });
  }

  /** "Open school": a 60-second, single-use hand-off token for the staff member's own active grant. */
  async open(actor: ConsoleActor, grantId: string): Promise<{ url: string }> {
    const grant = await this.db.runPlatform((tx) =>
      tx.supportAccessGrant.findUnique({ where: { id: grantId } }),
    );
    if (grant === null || grant.platformUserId !== actor.userId) throw new AppError('NOT_FOUND');
    const status = effectiveStatus(grant);
    if (status !== 'APPROVED' && status !== 'ACTIVE') {
      throw new AppError('INVALID_STATE', { detail: 'This access is not approved, or it has ended.' });
    }
    const host = await this.db.runPlatform(
      async (tx) =>
        (
          await tx.tenantDomain.findFirst({
            where: { tenantId: grant.tenantId, isPrimary: true, status: 'ACTIVE' },
            select: { hostname: true },
          })
        )?.hostname,
    );
    if (host === undefined) throw new AppError('NOT_FOUND');
    const handoff = issueToken();
    await this.db.runPlatformIn(grant.tenantId, async (tx) => {
      await tx.supportAccessGrant.update({
        where: { id: grantId },
        data: {
          handoffHash: Buffer.from(handoff.hash),
          handoffExpiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
        },
      });
      await recordPlatform(tx, {
        actorId: actor.userId,
        action: 'support.opened',
        entityType: 'support_access_grant',
        entityId: grantId,
        tenantRef: grant.tenantId,
      });
    });
    return {
      url: `${this.config.get('SCHOOL_URL_TEMPLATE').replace('{host}', host)}/support/open#token=${handoff.token}`,
    };
  }

  /** Staff end their own access early. */
  async end(actor: ConsoleActor, grantId: string): Promise<void> {
    const grant = await this.db.runPlatform((tx) =>
      tx.supportAccessGrant.findUnique({ where: { id: grantId } }),
    );
    if (grant === null || (grant.platformUserId !== actor.userId && actor.role !== 'PLATFORM_OWNER')) {
      throw new AppError('NOT_FOUND');
    }
    const status = effectiveStatus(grant);
    if (status !== 'APPROVED' && status !== 'ACTIVE' && status !== 'REQUESTED') {
      throw new AppError('INVALID_STATE', { detail: 'This access has already ended.' });
    }
    await this.db.runPlatformIn(grant.tenantId, async (tx) => {
      await tx.supportAccessGrant.update({
        where: { id: grantId },
        data: {
          status: 'REVOKED',
          revokedByStaff: actor.userId,
          revokedAt: new Date(),
          handoffHash: null,
          handoffExpiresAt: null,
        },
      });
      await tx.supportSession.deleteMany({ where: { grantId } });
      const entry = {
        actorId: actor.userId,
        action: 'support.ended',
        entityType: 'support_access_grant',
        entityId: grantId,
        tenantRef: grant.tenantId,
      };
      await recordPlatform(tx, entry);
      await recordInSchool(tx, grant.tenantId, entry);
    });
  }

  /** Requests go to the school's owners and administrators; emergency access to the owners at once. */
  private async notifySchool(
    tx: TenantTx,
    schoolName: string,
    host: string | null,
    reason: string,
    emergency: boolean,
  ) {
    const people = await tx.tenantMembership.findMany({
      where: {
        status: 'ACTIVE',
        roles: { some: { role: { in: emergency ? ['TENANT_OWNER'] : ['TENANT_OWNER', 'TENANT_ADMIN'] } } },
      },
      select: { displayNameOverride: true, user: { select: { email: true, displayName: true } } },
    });
    for (const person of people) {
      await queueEmail(tx, this.box, {
        template: 'support-request',
        to: person.user.email,
        vars: {
          schoolName,
          displayName: person.displayNameOverride ?? person.user.displayName,
          status: emergency ? 'EMERGENCY' : 'REQUESTED',
          reason,
          link:
            host === null
              ? ''
              : `${this.config.get('SCHOOL_URL_TEMPLATE').replace('{host}', host)}/admin/support-access`,
        },
      });
    }
  }
}
