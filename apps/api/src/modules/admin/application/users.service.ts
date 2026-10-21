import { Injectable } from '@nestjs/common';
import {
  type AdminUserDetail,
  type AdminUserRow,
  type AdminUsers,
  type AuditEntry,
  tenantRoleSchema,
} from '@studyhub/contracts';

import { AuditService } from '../../audit';
import { canManageMember, type TenantActor, type TenantRole } from '../../identity';
import {
  AppError,
  issueToken,
  queueEmail,
  requireTenantId,
  SecretBox,
  TenantDb,
  type TenantTx,
} from '../../platform';
import { requireAdmin, requireMember } from './guards';
import { auditEntries } from './audit-log.service';

const PAGE = 50;
const VERIFY_TTL_MS = 24 * 3600_000;

const MEMBER_SELECT = {
  id: true,
  status: true,
  joinedAt: true,
  displayNameOverride: true,
  user: { select: { id: true, displayName: true, email: true, emailVerifiedAt: true } },
  roles: { select: { role: true } },
  sessions: { orderBy: { lastSeenAt: 'desc' as const }, take: 1, select: { lastSeenAt: true } },
} as const;

type MemberRow = {
  id: string;
  status: AdminUserRow['status'];
  joinedAt: Date | null;
  displayNameOverride: string | null;
  user: { id: string; displayName: string; email: string; emailVerifiedAt: Date | null };
  roles: { role: string }[];
  sessions: { lastSeenAt: Date }[];
};

function toRow(member: MemberRow): AdminUserRow {
  return {
    membershipId: member.id,
    displayName: member.displayNameOverride ?? member.user.displayName,
    email: member.user.email,
    roles: member.roles
      .map((r) => r.role)
      .filter((r) => tenantRoleSchema.safeParse(r).success) as TenantRole[],
    status: member.status,
    emailVerified: member.user.emailVerifiedAt !== null,
    joinedAt: member.joinedAt?.toISOString() ?? null,
    lastActiveAt: member.sessions[0]?.lastSeenAt.toISOString() ?? null,
  };
}

/**
 * User management (F30, S-AD03): the school's own members only (RLS), never their other schools
 * (BR-70). Suspending ends the member's sessions in this school in the same transaction (BR-69, by
 * trigger); nobody can suspend themselves (F30 AC, BR-37).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly box: SecretBox,
  ) {}

  async search(
    actor: TenantActor,
    query: {
      q?: string | undefined;
      role?: TenantRole | undefined;
      status?: string | undefined;
      page: number;
    },
  ): Promise<AdminUsers> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const q = query.q?.trim();
      const where = {
        status:
          query.status === 'SUSPENDED'
            ? ('SUSPENDED' as const)
            : { in: ['ACTIVE' as const, 'SUSPENDED' as const] },
        ...(query.role !== undefined && { roles: { some: { role: query.role } } }),
        ...(q !== undefined &&
          q !== '' && {
            OR: [
              { displayNameOverride: { contains: q, mode: 'insensitive' as const } },
              { user: { displayName: { contains: q, mode: 'insensitive' as const } } },
              { user: { email: { contains: q.toLowerCase() } } },
            ],
          }),
      };
      const [members, total] = [
        await tx.tenantMembership.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * PAGE,
          take: PAGE,
          select: MEMBER_SELECT,
        }),
        await tx.tenantMembership.count({ where }),
      ];
      return { users: members.map((m) => toRow(m as MemberRow)), total };
    });
  }

  async detail(actor: TenantActor, membershipId: string): Promise<AdminUserDetail> {
    requireAdmin(actor);
    return this.db.run(async (tx) => {
      const member = await this.member(tx, membershipId);
      const enrollments = await tx.enrollment.findMany({
        where: { membershipId },
        orderBy: { startedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          courseId: true,
          status: true,
          source: true,
          startedAt: true,
          course: { select: { title: true } },
        },
      });
      const orders = await tx.order.findMany({
        where: { membershipId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          status: true,
          totalMinor: true,
          currency: true,
          createdAt: true,
          items: { take: 1, select: { titleSnapshot: true } },
        },
      });
      const sessions = await tx.session.findMany({
        where: { membershipId, replacedAt: null },
        orderBy: { lastSeenAt: 'desc' },
        select: { id: true, createdAt: true, lastSeenAt: true, userAgent: true, ip: true },
      });
      const audit = await auditEntries(tx, {
        where: {
          OR: [{ entityId: membershipId }, { actorId: member.user.id }],
        },
        take: 50,
      });
      return {
        user: { ...toRow(member), isSelf: member.id === actor.membershipId },
        enrollments: enrollments.map((e) => ({
          id: e.id,
          courseId: e.courseId,
          courseTitle: e.course.title,
          status: e.status,
          source: e.source,
          enrolledAt: e.startedAt.toISOString(),
        })),
        orders: orders.map((o) => ({
          id: o.id,
          courseTitle: o.items[0]?.titleSnapshot ?? '—',
          amountMinor: Number(o.totalMinor),
          currency: o.currency,
          status: o.status,
          createdAt: o.createdAt.toISOString(),
        })),
        sessions: sessions.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          userAgent: s.userAgent,
          ip: s.ip,
        })),
        audit: audit.entries satisfies AuditEntry[],
      };
    });
  }

  async setSuspended(
    actor: TenantActor,
    membershipId: string,
    suspend: boolean,
    reason: string,
  ): Promise<void> {
    requireAdmin(actor);
    requireMember(actor);
    if (membershipId === actor.membershipId) {
      throw new AppError('FORBIDDEN', { detail: "You can't suspend yourself." });
    }
    try {
      await this.db.run(async (tx) => {
        const member = await this.member(tx, membershipId);
        const roles = member.roles.map((r) => r.role) as TenantRole[];
        if (!canManageMember(actor, roles)) throw new AppError('FORBIDDEN');
        if (suspend === (member.status === 'SUSPENDED')) return;
        await tx.tenantMembership.update({
          where: { id: membershipId },
          data: suspend
            ? { status: 'SUSPENDED', suspendedAt: new Date(), version: { increment: 1 } }
            : { status: 'ACTIVE', suspendedAt: null, version: { increment: 1 } },
        });
        await this.audit.record(tx, {
          action: suspend ? 'membership.suspended' : 'membership.unsuspended',
          entityType: 'membership',
          entityId: membershipId,
          actorId: actor.userId,
          before: { status: member.status },
          after: { status: suspend ? 'SUSPENDED' : 'ACTIVE', reason },
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('BR-58')) throw new AppError('LAST_OWNER');
      throw error;
    }
  }

  /** Resends the verification email of an unverified member (S-AD03). */
  async resendVerification(actor: TenantActor, membershipId: string, host: string): Promise<void> {
    requireAdmin(actor);
    await this.db.run(async (tx) => {
      const member = await this.member(tx, membershipId);
      if (member.user.emailVerifiedAt !== null) {
        throw new AppError('INVALID_STATE', { detail: 'This email address is already verified.' });
      }
      const verify = issueToken();
      // The token belongs to the member's own account: it is written as that account (app.user_id).
      await tx.$executeRaw`SELECT set_config('app.user_id', ${member.user.id}, true)`;
      await tx.oneTimeToken.create({
        data: {
          userId: member.user.id,
          purpose: 'VERIFY_EMAIL',
          tokenHash: verify.hash,
          contextTenantId: requireTenantId(),
          expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
        },
      });
      await tx.$executeRaw`SELECT set_config('app.user_id', ${actor.userId}, true)`;
      const school = await tx.tenantBranding.findFirst({ select: { displayName: true } });
      const scheme = host.endsWith('.localhost') || host.startsWith('localhost') ? 'http' : 'https';
      await queueEmail(tx, this.box, {
        template: 'verify-email',
        to: member.user.email,
        vars: {
          schoolName: school?.displayName ?? 'Your school',
          displayName: member.user.displayName,
          link: `${scheme}://${host}/verify-email#token=${verify.token}`,
        },
      });
      await this.audit.record(tx, {
        action: 'membership.verification_resent',
        entityType: 'membership',
        entityId: membershipId,
        actorId: actor.userId,
      });
    });
  }

  /** Ends one of a member's sessions in this school (S-AD03 Sessions tab). */
  async revokeSession(actor: TenantActor, membershipId: string, sessionId: string): Promise<void> {
    requireAdmin(actor);
    await this.db.run(async (tx) => {
      const deleted = await tx.session.deleteMany({ where: { id: sessionId, membershipId } });
      if (deleted.count === 0) throw new AppError('NOT_FOUND');
      await this.audit.record(tx, {
        action: 'session.revoked',
        entityType: 'session',
        entityId: sessionId,
        actorId: actor.userId,
        after: { membershipId },
      });
    });
  }

  private async member(tx: TenantTx, membershipId: string): Promise<MemberRow> {
    const member = await tx.tenantMembership.findFirst({
      where: { id: membershipId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      select: MEMBER_SELECT,
    });
    if (member === null) throw new AppError('NOT_FOUND');
    return member as MemberRow;
  }
}
