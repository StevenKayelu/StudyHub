import { Injectable } from '@nestjs/common';

import { hashToken, issueToken, isWellFormedToken, TenantDb, type TenantTx } from '../../platform';
import { sessionLifetime, TENANT_ROLES, type TenantActor, type TenantRole } from '../domain/policy';

/** Idle expiry is extended at most this often, so active browsing doesn't write on every request. */
const SLIDE_AFTER_MS = 5 * 60_000;

export interface NewSession {
  token: string;
  sessionId: string;
  maxAgeSeconds: number;
}

const isRole = (value: string): value is TenantRole => (TENANT_ROLES as readonly string[]).includes(value);

/**
 * Tenant-realm sessions (04 §8, D4). A session row belongs to ONE school (tenant_id, under RLS), so a
 * cookie replayed on another school's host finds nothing there and is anonymous (BR-44).
 */
@Injectable()
export class SessionService {
  constructor(private readonly tenantDb: TenantDb) {}

  /** Creates a session in the caller's tenant transaction. */
  async create(
    tx: TenantTx,
    input: {
      tenantId: string;
      userId: string;
      membershipId: string;
      roles: readonly TenantRole[];
      ip: string | null;
      userAgent: string | null;
    },
  ): Promise<NewSession> {
    const { token, hash } = issueToken();
    const now = Date.now();
    const lifetime = sessionLifetime(input.roles);
    const session = await tx.session.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        membershipId: input.membershipId,
        tokenHash: hash,
        idleExpiresAt: new Date(now + lifetime.idleMs),
        absoluteExpiresAt: new Date(now + lifetime.absoluteMs),
        ip: input.ip,
        userAgent: input.userAgent,
      },
      select: { id: true },
    });
    return { token, sessionId: session.id, maxAgeSeconds: lifetime.absoluteMs / 1000 };
  }

  /**
   * The actor for a session cookie on the current school host, or null. Requires an unexpired session,
   * an ACTIVE membership and an ACTIVE account; slides the idle expiry.
   */
  async authenticate(token: string): Promise<TenantActor | null> {
    if (!isWellFormedToken(token)) return null;
    const hash = hashToken(token);
    return this.tenantDb.run(async (tx) => {
      const now = new Date();
      const session = await tx.session.findFirst({
        where: { tokenHash: hash, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
        select: {
          id: true,
          userId: true,
          lastSeenAt: true,
          absoluteExpiresAt: true,
          membership: {
            select: {
              id: true,
              status: true,
              roles: { select: { role: true } },
              user: { select: { status: true } },
            },
          },
        },
      });
      if (session === null) return null;
      const { membership } = session;
      if (membership.status !== 'ACTIVE' || membership.user.status !== 'ACTIVE') return null;
      const roles = membership.roles.map((r) => r.role).filter(isRole);

      if (now.getTime() - session.lastSeenAt.getTime() > SLIDE_AFTER_MS) {
        const idle = Math.min(
          now.getTime() + sessionLifetime(roles).idleMs,
          session.absoluteExpiresAt.getTime(),
        );
        await tx.session.update({
          where: { id: session.id },
          data: { lastSeenAt: now, idleExpiresAt: new Date(idle) },
        });
      }
      return { userId: session.userId, membershipId: membership.id, sessionId: session.id, roles };
    });
  }

  /** Ends one session of the current school (sign-out). */
  async end(sessionId: string): Promise<void> {
    await this.tenantDb.run((tx) => tx.session.deleteMany({ where: { id: sessionId } }));
  }
}
