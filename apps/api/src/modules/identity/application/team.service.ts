import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { InvitationPreview, TeamResponse } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import { enforceLimit, type LimitKind } from '../../tenancy';
import {
  AppError,
  hashPassword,
  hashToken,
  issueToken,
  isWellFormedToken,
  queueEmail,
  RATE_RULES,
  RateLimiter,
  requireTenantId,
  SecretBox,
  TenantDb,
  type TenantTx,
  verifyPassword,
} from '../../platform';
import {
  can,
  canManageMember,
  canManageRole,
  TENANT_ROLES,
  type TenantActor,
  type TenantRole,
} from '../domain/policy';
import { AuthService, type RequestMeta, type SignedIn } from './auth.service';
import { SessionService } from './sessions';

const INVITATION_TTL_MS = 7 * 24 * 3600_000;

const ROLE_LABELS: Record<TenantRole, string> = {
  LEARNER: 'a learner',
  INSTRUCTOR: 'an instructor',
  TENANT_ADMIN: 'an administrator',
  TENANT_OWNER: 'an owner',
};

const isRole = (value: string): value is TenantRole => (TENANT_ROLES as readonly string[]).includes(value);

/** The plan limit a role counts against (BR-49). */
export function limitForRole(role: TenantRole): LimitKind {
  if (role === 'INSTRUCTOR') return 'instructors';
  if (role === 'TENANT_ADMIN' || role === 'TENANT_OWNER') return 'admins';
  return 'activeLearners';
}

/** A database rejection from the BR-58 owner trigger (checked at commit). */
function isLastOwnerViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('BR-58');
}

/**
 * School team management (S-AD14) and invitations (BR-67). The school sees its members' names, emails
 * and roles here, never their other schools (BR-70); it can't change a member's email or password.
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly box: SecretBox,
    private readonly limiter: RateLimiter,
    private readonly auth: AuthService,
  ) {}

  async team(actor: TenantActor): Promise<TeamResponse> {
    this.require(actor, 'team.view');
    return this.tenantDb.run(async (tx) => {
      const members = await tx.tenantMembership.findMany({
        where: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          joinedAt: true,
          displayNameOverride: true,
          user: { select: { displayName: true, email: true } },
          roles: { select: { role: true } },
        },
      });
      const invitations = await tx.invitation.findMany({
        where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, role: true, expiresAt: true },
      });
      return {
        members: members.map((m) => ({
          membershipId: m.id,
          displayName: m.displayNameOverride ?? m.user.displayName,
          email: m.user.email,
          roles: m.roles.map((r) => r.role).filter(isRole),
          status: m.status,
          joinedAt: m.joinedAt?.toISOString() ?? null,
        })),
        invitations: invitations.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          expiresAt: i.expiresAt.toISOString(),
        })),
      };
    });
  }

  /** Invites someone; an open invitation for the same email and role is replaced (a resend). */
  async invite(
    actor: TenantActor,
    input: { email: string; role: TenantRole },
    meta: RequestMeta,
  ): Promise<{ id: string }> {
    this.require(actor, 'team.invite');
    if (!canManageRole(actor, input.role)) throw new AppError('FORBIDDEN');
    this.limiter.enforce([[`email:ip:${meta.ip ?? 'unknown'}`, RATE_RULES.emailPerIp]]);
    const tenantId = requireTenantId();
    const invitation = issueToken();
    return this.tenantDb.run(async (tx) => {
      await tx.invitation.updateMany({
        where: { email: input.email, role: input.role, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // BR-49: an open invitation holds a seat, so invitations can't overshoot the plan.
      await enforceLimit(tx, limitForRole(input.role), { box: this.box });
      const created = await tx.invitation.create({
        data: {
          tenantId,
          email: input.email,
          role: input.role,
          tokenHash: invitation.hash,
          invitedBy: actor.userId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
        select: { id: true },
      });
      await queueEmail(tx, this.box, {
        template: 'invitation',
        to: input.email,
        vars: {
          schoolName: await this.auth.schoolName(tx),
          roleLabel: ROLE_LABELS[input.role],
          link: await this.auth.link(meta.host, `/invitations/accept#token=${invitation.token}`),
        },
      });
      await this.audit.record(tx, {
        action: 'invitation.created',
        entityType: 'invitation',
        entityId: created.id,
        actorId: actor.userId,
        after: { email: input.email, role: input.role },
      });
      return created;
    });
  }

  /**
   * Ownership transfer (S-AD14): an owner invites an existing administrator to become an owner; the new
   * owner must accept. The current owner stays an owner until removed (M9 PROPOSED, BR-58 keeps one).
   */
  async transferOwnership(
    actor: TenantActor,
    membershipId: string,
    meta: RequestMeta,
  ): Promise<{ id: string }> {
    if (!actor.roles.includes('TENANT_OWNER')) throw new AppError('FORBIDDEN');
    const target = await this.tenantDb.run((tx) =>
      tx.tenantMembership.findFirst({
        where: { id: membershipId, status: 'ACTIVE' },
        select: { roles: { select: { role: true } }, user: { select: { email: true } } },
      }),
    );
    if (target === null) throw new AppError('NOT_FOUND');
    const roles = target.roles.map((r) => r.role);
    if (roles.includes('TENANT_OWNER'))
      throw new AppError('INVALID_STATE', { detail: 'This person is already an owner.' });
    if (!roles.includes('TENANT_ADMIN')) {
      throw new AppError('INVALID_STATE', { detail: 'Make this person an administrator first.' });
    }
    return this.invite(actor, { email: target.user.email, role: 'TENANT_OWNER' }, meta);
  }

  async revokeInvitation(actor: TenantActor, invitationId: string): Promise<void> {
    this.require(actor, 'team.invite');
    await this.tenantDb.run(async (tx) => {
      const invitation = await tx.invitation.findFirst({
        where: { id: invitationId, acceptedAt: null, revokedAt: null },
        select: { id: true, role: true },
      });
      if (invitation === null) throw new AppError('NOT_FOUND');
      if (!canManageRole(actor, invitation.role)) throw new AppError('FORBIDDEN');
      await tx.invitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, {
        action: 'invitation.revoked',
        entityType: 'invitation',
        entityId: invitation.id,
        actorId: actor.userId,
      });
    });
  }

  async changeRoles(actor: TenantActor, membershipId: string, roles: TenantRole[]): Promise<void> {
    this.require(actor, 'member.changeRoles');
    const wanted = [...new Set(roles)];
    try {
      await this.tenantDb.run(async (tx) => {
        const member = await this.member(tx, membershipId);
        const current = member.roles;
        const added = wanted.filter((role) => !current.includes(role));
        const removed = current.filter((role) => !wanted.includes(role));
        if (![...added, ...removed].every((role) => canManageRole(actor, role)))
          throw new AppError('FORBIDDEN');
        if (removed.includes('TENANT_OWNER') && (await this.auth.activeOwnerCount(tx)) <= 1) {
          throw new AppError('LAST_OWNER');
        }
        await tx.membershipRole.deleteMany({ where: { membershipId, role: { in: removed } } });
        for (const kind of new Set(added.filter((r) => r !== 'LEARNER').map(limitForRole))) {
          await enforceLimit(tx, kind, { box: this.box, includeInvitations: true });
        }
        for (const role of added) {
          await tx.membershipRole.create({
            data: { tenantId: requireTenantId(), membershipId, role, grantedBy: actor.userId },
          });
        }
        // New rights take effect at the member's next sign-in: end their sessions here.
        if (added.length > 0 || removed.length > 0) await tx.session.deleteMany({ where: { membershipId } });
        await this.audit.record(tx, {
          action: 'membership.roles_changed',
          entityType: 'membership',
          entityId: membershipId,
          actorId: actor.userId,
          before: { roles: current },
          after: { roles: wanted },
        });
      });
    } catch (error) {
      if (isLastOwnerViolation(error)) throw new AppError('LAST_OWNER');
      throw error;
    }
  }

  /** Removes a member: status REVOKED; the database ends their sessions here (BR-69). */
  async removeMember(actor: TenantActor, membershipId: string): Promise<void> {
    this.require(actor, 'member.remove');
    try {
      await this.tenantDb.run(async (tx) => {
        const member = await this.member(tx, membershipId);
        if (!canManageMember(actor, member.roles)) throw new AppError('FORBIDDEN');
        if (member.roles.includes('TENANT_OWNER') && (await this.auth.activeOwnerCount(tx)) <= 1) {
          throw new AppError('LAST_OWNER');
        }
        await tx.tenantMembership.update({
          where: { id: membershipId },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            revokedBy: actor.userId,
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          action: 'membership.revoked',
          entityType: 'membership',
          entityId: membershipId,
          actorId: actor.userId,
        });
      });
    } catch (error) {
      if (isLastOwnerViolation(error)) throw new AppError('LAST_OWNER');
      throw error;
    }
  }

  // ----------------------------------------------------------------------------------------------
  // Accepting an invitation (BR-67): one transaction; creates the account first if none exists.
  // ----------------------------------------------------------------------------------------------

  async preview(token: string): Promise<InvitationPreview> {
    return this.tenantDb.run(async (tx) => {
      const invitation = await this.openInvitation(tx, token);
      const rows = await tx.$queryRaw<
        { user_id: string }[]
      >`SELECT user_id FROM auth_lookup(${invitation.email})`;
      return {
        schoolName: await this.auth.schoolName(tx),
        email: invitation.email,
        role: invitation.role,
        accountExists: rows.length > 0,
      };
    });
  }

  async accept(
    input: { token: string; password?: string | undefined; displayName?: string | undefined },
    meta: RequestMeta,
    signedIn: TenantActor | null,
  ): Promise<SignedIn | null> {
    this.limiter.enforce([[`token:ip:${meta.ip ?? 'unknown'}`, RATE_RULES.tokenPerIp]]);
    const tenantId = requireTenantId();
    const invitation = await this.tenantDb.run((tx) => this.openInvitation(tx, input.token));
    const [account] = await this.tenantDb.run(
      (tx) =>
        tx.$queryRaw<{ user_id: string; password_hash: string | null; status: string }[]>`
        SELECT user_id, password_hash, status::text AS status FROM auth_lookup(${invitation.email})`,
    );

    let userId: string;
    let newAccount: { displayName: string; passwordHash: string } | null = null;
    if (account !== undefined) {
      if (account.status !== 'ACTIVE') throw new AppError('TOKEN_INVALID');
      // Already signed in here as the invited person, or proving it with the account password.
      const proven =
        signedIn?.userId === account.user_id ||
        (input.password !== undefined &&
          account.password_hash !== null &&
          (await verifyPassword(account.password_hash, input.password)));
      if (!proven) throw new AppError('INVALID_CREDENTIALS');
      userId = account.user_id;
    } else {
      if (input.password === undefined || input.displayName === undefined) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [
            { field: 'password', code: 'required', message: 'Choose a password to create your account' },
          ],
        });
      }
      await this.auth.assertPasswordAcceptable(input.password, invitation.email, 'password');
      userId = randomUUID();
      newAccount = { displayName: input.displayName, passwordHash: await hashPassword(input.password) };
    }

    return this.tenantDb.runAs(userId, async (tx) => {
      // Re-check inside the transaction and consume it: single use even under concurrent accepts.
      const consumed = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (consumed.count !== 1) throw new AppError('TOKEN_INVALID');
      if (newAccount !== null) {
        await tx.userAccount.create({
          data: {
            id: userId,
            email: invitation.email,
            displayName: newAccount.displayName,
            // The invitation link proves control of the inbox.
            emailVerifiedAt: new Date(),
          },
        });
        await tx.credential.create({ data: { userId, passwordHash: newAccount.passwordHash } });
      }
      let membership = await tx.tenantMembership.findFirst({
        where: { userId },
        select: { id: true, status: true, roles: { select: { role: true } } },
      });
      // Staff invitations held their seat; a new learner takes one now (BR-49).
      if (invitation.role === 'LEARNER' && membership?.status !== 'ACTIVE') {
        await enforceLimit(tx, 'activeLearners', { box: this.box });
      }
      if (membership === null) {
        const created = await tx.tenantMembership.create({
          data: { tenantId, userId, status: 'ACTIVE', joinedAt: new Date() },
          select: { id: true },
        });
        membership = { id: created.id, status: 'ACTIVE', roles: [] };
      } else if (membership.status !== 'ACTIVE') {
        await tx.tenantMembership.update({
          where: { id: membership.id },
          data: { status: 'ACTIVE', revokedAt: null, suspendedAt: null, version: { increment: 1 } },
        });
      }
      const roles = membership.roles.map((r) => r.role).filter(isRole);
      if (!roles.includes(invitation.role)) {
        await tx.membershipRole.create({
          data: {
            tenantId,
            membershipId: membership.id,
            role: invitation.role,
            grantedBy: invitation.invitedBy,
          },
        });
        roles.push(invitation.role);
      }
      // Everyone holds at least the learner role.
      if (!roles.includes('LEARNER')) {
        await tx.membershipRole.create({ data: { tenantId, membershipId: membership.id, role: 'LEARNER' } });
        roles.push('LEARNER');
      }
      await this.audit.record(tx, {
        action: 'invitation.accepted',
        entityType: 'membership',
        entityId: membership.id,
        actorId: userId,
        after: { role: invitation.role, newAccount: newAccount !== null },
      });
      // A signed-in invitee keeps their session (its rights refresh at next sign-in); else sign in now.
      if (signedIn?.userId === userId) {
        await tx.session.deleteMany({ where: { id: signedIn.sessionId } });
      }
      const session = await this.sessions.create(tx, {
        tenantId,
        userId,
        membershipId: membership.id,
        roles,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { token: session.token, maxAgeSeconds: session.maxAgeSeconds };
    });
  }

  private async openInvitation(tx: TenantTx, token: string) {
    if (!isWellFormedToken(token)) throw new AppError('TOKEN_INVALID');
    const invitation = await tx.invitation.findFirst({
      where: {
        tokenHash: hashToken(token),
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, email: true, role: true, invitedBy: true },
    });
    if (invitation === null) throw new AppError('TOKEN_INVALID');
    return invitation;
  }

  private async member(tx: TenantTx, membershipId: string): Promise<{ roles: TenantRole[] }> {
    const member = await tx.tenantMembership.findFirst({
      where: { id: membershipId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      select: { roles: { select: { role: true } } },
    });
    // Another school's membership is invisible here (RLS), so it is simply not found.
    if (member === null) throw new AppError('NOT_FOUND');
    return { roles: member.roles.map((r) => r.role).filter(isRole) };
  }

  private require(actor: TenantActor, action: Parameters<typeof can>[1]): void {
    if (!can(actor, action)) throw new AppError('FORBIDDEN');
  }
}
