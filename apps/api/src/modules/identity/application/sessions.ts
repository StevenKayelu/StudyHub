import { Injectable } from '@nestjs/common';
import { generalSettingsFrom } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import {
  hashToken,
  issueToken,
  isWellFormedToken,
  queueEmail,
  requireTenantId,
  SecretBox,
  TenantDb,
  type TenantTx,
} from '../../platform';
import { sessionLifetime, TENANT_ROLES, type TenantActor, type TenantRole } from '../domain/policy';
import { deviceLabel, replacesOtherSessions } from '../domain/single-device';

/** Idle expiry is extended at most this often, so active browsing doesn't write on every request. */
const SLIDE_AFTER_MS = 5 * 60_000;

export interface NewSession {
  token: string;
  sessionId: string;
  maxAgeSeconds: number;
}

/** A cookie whose session was replaced by a sign-in on another device (single-device-learners.md). */
export const REPLACED = 'REPLACED';

const isRole = (value: string): value is TenantRole => (TENANT_ROLES as readonly string[]).includes(value);

/**
 * Tenant-realm sessions (04 §8, D4). A session row belongs to ONE school (tenant_id, under RLS), so a
 * cookie replayed on another school's host finds nothing there and is anonymous (BR-44).
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly box: SecretBox,
  ) {}

  /**
   * Creates a session in the caller's tenant transaction. A learner's new session replaces their other
   * sessions in this school while the school allows one device at a time; the account is emailed.
   */
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
    await this.replaceOthers(tx, input, session.id);
    return { token, sessionId: session.id, maxAgeSeconds: lifetime.absoluteMs / 1000 };
  }

  private async replaceOthers(
    tx: TenantTx,
    input: { userId: string; membershipId: string; roles: readonly TenantRole[]; userAgent: string | null },
    sessionId: string,
  ): Promise<void> {
    const general = generalSettingsFrom(
      await tx.tenantSetting.findMany({
        where: { key: 'singleDeviceLearners' },
        select: { key: true, value: true },
      }),
    );
    if (!replacesOtherSessions(input.roles, general.singleDeviceLearners)) return;
    const now = new Date();
    const replaced = await tx.session.updateMany({
      where: {
        membershipId: input.membershipId,
        id: { not: sessionId },
        replacedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
      data: { replacedAt: now },
    });
    if (replaced.count === 0) return;
    const device = deviceLabel(input.userAgent);
    await this.audit.record(tx, {
      action: 'auth.sessions_replaced',
      entityType: 'session',
      entityId: sessionId,
      actorId: input.userId,
      after: { replaced: replaced.count, device },
    });
    const [account, tenant] = await Promise.all([
      tx.userAccount.findUnique({ where: { id: input.userId }, select: { email: true, displayName: true } }),
      tx.tenant.findUnique({
        where: { id: requireTenantId() },
        select: { name: true, branding: { select: { displayName: true, status: true } } },
      }),
    ]);
    if (account === null) return;
    const schoolName =
      tenant?.branding?.status === 'PUBLISHED' ? tenant.branding.displayName : (tenant?.name ?? 'StudyHub');
    await queueEmail(tx, this.box, {
      template: 'signed-in-elsewhere',
      to: account.email,
      vars: { schoolName, displayName: account.displayName, detail: device },
    });
  }

  /**
   * The actor for a session cookie on the current school host, or null. Requires an unexpired session,
   * an ACTIVE membership and an ACTIVE account; slides the idle expiry. A session replaced by a sign-in
   * on another device is REPLACED, so the device can be told why it was signed out.
   */
  async authenticate(token: string): Promise<TenantActor | typeof REPLACED | null> {
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
          replacedAt: true,
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
      if (session.replacedAt !== null) return REPLACED;
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
