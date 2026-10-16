import { Injectable } from '@nestjs/common';

import {
  AppError,
  currentContext,
  hashToken,
  issueToken,
  isWellFormedToken,
  RATE_RULES,
  RateLimiter,
  requireTenantId,
  TenantDb,
  type TenantTx,
} from '../../platform';
import { SUPPORT_MEMBERSHIP_ID, type TenantActor } from '../domain/policy';
import type { RequestMeta } from './auth.service';

export interface NewSupportSession {
  token: string;
  maxAgeSeconds: number;
}

/**
 * Support sessions (F44, 04 §17.12): platform staff open an approved grant from the console, which
 * issues a 60-second, single-use hand-off token; the school host exchanges it here for a support
 * session that ends with the grant. Every step is written to BOTH audit logs in one transaction
 * (a console transaction inside this school, design §1).
 */
@Injectable()
export class SupportSessionService {
  constructor(
    private readonly db: TenantDb,
    private readonly limiter: RateLimiter,
  ) {}

  async exchange(token: string, meta: RequestMeta): Promise<NewSupportSession> {
    this.limiter.enforce([[`token:ip:${meta.ip ?? 'unknown'}`, RATE_RULES.tokenPerIp]]);
    if (!isWellFormedToken(token)) throw new AppError('TOKEN_INVALID');
    const tenantId = requireTenantId();
    const now = new Date();
    return this.db.runPlatformIn(tenantId, async (tx) => {
      const grant = await tx.supportAccessGrant.findFirst({
        where: {
          tenantId,
          handoffHash: hashToken(token),
          handoffExpiresAt: { gt: now },
          status: { in: ['APPROVED', 'ACTIVE'] },
          expiresAt: { gt: now },
          revokedAt: null,
        },
        select: { id: true, platformUserId: true, expiresAt: true, scope: true },
      });
      if (grant === null || grant.expiresAt === null) throw new AppError('TOKEN_INVALID');
      // Single use: the hand-off is cleared in the same transaction.
      await tx.supportAccessGrant.update({
        where: { id: grant.id },
        data: { handoffHash: null, handoffExpiresAt: null, status: 'ACTIVE' },
      });
      const issued = issueToken();
      const session = await tx.supportSession.create({
        data: {
          tenantId,
          grantId: grant.id,
          platformUserId: grant.platformUserId,
          tokenHash: issued.hash,
          expiresAt: grant.expiresAt,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        select: { id: true },
      });
      await recordBoth(tx, grant.platformUserId, 'support.session_started', 'support_session', session.id, {
        grantId: grant.id,
        scope: grant.scope,
      });
      return {
        token: issued.token,
        maxAgeSeconds: Math.max(1, Math.floor((grant.expiresAt.getTime() - now.getTime()) / 1000)),
      };
    });
  }

  /**
   * The actor for a support cookie, or null. The grant is re-checked on every request, so an expired or
   * revoked grant stops working on the next request (F44 AC 1).
   */
  async authenticate(token: string): Promise<TenantActor | null> {
    if (!isWellFormedToken(token)) return null;
    const now = new Date();
    return this.db.run(async (tx) => {
      const session = await tx.supportSession.findFirst({
        where: { tokenHash: hashToken(token), expiresAt: { gt: now } },
        select: {
          id: true,
          platformUserId: true,
          grant: {
            select: {
              id: true,
              status: true,
              scope: true,
              expiresAt: true,
              revokedAt: true,
              staffDisplayName: true,
            },
          },
        },
      });
      const grant = session?.grant;
      if (
        session === null ||
        grant === undefined ||
        grant.status !== 'ACTIVE' ||
        grant.revokedAt !== null ||
        grant.expiresAt === null ||
        grant.expiresAt <= now
      ) {
        return null;
      }
      return {
        userId: session.platformUserId,
        membershipId: SUPPORT_MEMBERSHIP_ID,
        sessionId: session.id,
        roles: ['TENANT_ADMIN'],
        support: {
          grantId: grant.id,
          platformUserId: session.platformUserId,
          staffName: grant.staffDisplayName,
          scope: grant.scope,
          expiresAt: grant.expiresAt,
        },
      };
    });
  }

  async end(actor: TenantActor): Promise<void> {
    const support = actor.support;
    if (support === undefined) throw new AppError('FORBIDDEN');
    await this.db.runPlatformIn(requireTenantId(), async (tx) => {
      await tx.supportSession.deleteMany({ where: { id: actor.sessionId } });
      await recordBoth(
        tx,
        support.platformUserId,
        'support.session_ended',
        'support_session',
        actor.sessionId,
        {
          grantId: support.grantId,
        },
      );
    });
  }

  /** One entry per request in each log (F49 AC: support actions produce one entry in each). */
  async recordRequest(
    actor: TenantActor,
    request: { method: string; url: string; status: number },
  ): Promise<void> {
    const support = actor.support;
    if (support === undefined) return;
    await this.db.runPlatformIn(requireTenantId(), (tx) =>
      recordBoth(tx, support.platformUserId, 'support.request', 'support_grant', support.grantId, {
        method: request.method,
        path: request.url.split('?')[0]?.slice(0, 300),
        status: request.status,
        scope: support.scope,
      }),
    );
  }
}

/** Writes the same entry to the school's audit log and the platform audit log. */
export async function recordBoth(
  tx: TenantTx,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  after: Record<string, unknown>,
): Promise<void> {
  const tenantId = requireTenantId();
  const requestId = currentContext()?.requestId ?? null;
  const json = after as object;
  await tx.auditLog.create({
    data: { tenantId, actorId, action, entityType, entityId, after: json, requestId },
  });
  await tx.platformAuditLog.create({
    data: { actorId, tenantRef: tenantId, action, entityType, entityId, after: json, requestId },
  });
}
