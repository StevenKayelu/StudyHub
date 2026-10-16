import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { MeResponse, MySchoolsResponse } from '@studyhub/contracts';

import { AuditService } from '../../audit';
import {
  AppError,
  type BreachedPasswordChecker,
  ConfigService,
  currentContext,
  decoyPasswordHash,
  hashPassword,
  hashToken,
  issueToken,
  isWellFormedToken,
  PrismaService,
  passwordProblem,
  queueEmail,
  RATE_RULES,
  RateLimiter,
  requireTenantId,
  SecretBox,
  TenantDb,
  type TenantTx,
  verifyPassword,
} from '../../platform';
import { enforceLimit, TenantResolver } from '../../tenancy';
import { allowedActions, TENANT_ROLES, type TenantActor, type TenantRole } from '../domain/policy';
import { SessionService } from './sessions';

const HOUR = 3600_000;
const VERIFY_TTL_MS = 24 * HOUR;
const RESET_TTL_MS = HOUR;
const HANDOFF_TTL_MS = 60_000;
const JOIN_TICKET_TTL_MS = 10 * 60_000;
/** Consecutive failures that lock an account for LOCK_MS (persisted; the rate limiter covers the rest). */
const LOCK_AFTER_FAILURES = 10;
const LOCK_MS = 15 * 60_000;

export const BREACHED_PASSWORD_CHECKER = Symbol('BREACHED_PASSWORD_CHECKER');

/** Who is asking, as seen through trusted proxies only. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  /** The request host (the school's host), used for links in emails. */
  host: string;
}

/** A flow that signs the person in returns the new session cookie for the controller to set. */
export interface SignedIn {
  token: string;
  maxAgeSeconds: number;
}

interface AuthLookupRow {
  user_id: string;
  status: 'ACTIVE' | 'LOCKED' | 'DELETION_REQUESTED' | 'DELETED';
  email_verified: boolean;
  password_hash: string | null;
  failed_count: number | null;
  locked_until: Date | null;
}

interface JoinTicket {
  userId: string;
  tenantId: string;
  expiresAt: number;
}

const isRole = (value: string): value is TenantRole => (TENANT_ROLES as readonly string[]).includes(value);

const passwordMessages = {
  TOO_SHORT: 'Use at least 10 characters',
  TOO_LONG: 'Use at most 128 characters',
  CONTAINS_EMAIL: "Don't use your email address in your password",
  COMMON_OR_BREACHED: 'This password is too common or has appeared in a data breach. Choose another.',
} as const;

/**
 * Tenant-realm identity flows (D3, D4; BR-65 to BR-71). Every response that could reveal whether an
 * email has an account is generic. Sign-in, registration and reset run on a school host, inside that
 * school's tenant context; account-level data is touched only as the account itself (app.user_id).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly box: SecretBox,
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService,
    private readonly resolver: TenantResolver,
    @Inject(BREACHED_PASSWORD_CHECKER) private readonly breached: BreachedPasswordChecker,
  ) {}

  // ----------------------------------------------------------------------------------------------
  // Registration (S-A02, BR-66, BR-57)
  // ----------------------------------------------------------------------------------------------

  async register(
    input: { displayName: string; email: string; password: string },
    meta: RequestMeta,
  ): Promise<void> {
    const tenantId = requireTenantId();
    this.limiter.enforce([
      [`register:ip:${meta.ip ?? 'unknown'}`, RATE_RULES.registerPerIp],
      [`register:tenant:${tenantId}`, RATE_RULES.registerPerTenant],
    ]);
    // Rules that don't depend on whether the email exists come first, so their answers reveal nothing.
    await this.assertRegistrationAllowed(input.email);
    await this.assertPasswordAcceptable(input.password, input.email, 'password');

    const [existing] = await this.lookup(input.email);
    if (existing !== undefined) {
      // BR-66: same response as a new registration; the owner of the inbox is told how to join.
      await decoyPasswordHash();
      await this.tenantDb.run(async (tx) => {
        const school = await this.schoolName(tx);
        await queueEmail(tx, this.box, {
          template: 'account-exists',
          to: input.email,
          vars: { schoolName: school, link: await this.link(meta.host, '/sign-in') },
        });
      });
      return;
    }

    const userId = randomUUID();
    const passwordHash = await hashPassword(input.password);
    const verify = issueToken();
    try {
      await this.tenantDb.runAs(userId, async (tx) => {
        await tx.userAccount.create({
          data: { id: userId, email: input.email, displayName: input.displayName },
        });
        await tx.credential.create({ data: { userId, passwordHash } });
        await enforceLimit(tx, 'activeLearners', { box: this.box });
        const membership = await tx.tenantMembership.create({
          data: { tenantId, userId, status: 'ACTIVE', joinedAt: new Date() },
          select: { id: true },
        });
        await tx.membershipRole.create({ data: { tenantId, membershipId: membership.id, role: 'LEARNER' } });
        await tx.oneTimeToken.create({
          data: {
            userId,
            purpose: 'VERIFY_EMAIL',
            tokenHash: verify.hash,
            contextTenantId: tenantId,
            expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
          },
        });
        const school = await this.schoolName(tx);
        await queueEmail(tx, this.box, {
          template: 'verify-email',
          to: input.email,
          vars: {
            schoolName: school,
            displayName: input.displayName,
            link: await this.link(meta.host, `/verify-email#token=${verify.token}`),
          },
        });
        await this.audit.record(tx, {
          action: 'account.registered',
          entityType: 'membership',
          entityId: membership.id,
          actorId: userId,
        });
      });
    } catch (error) {
      // A concurrent registration with the same email: answer exactly as above.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }

  // ----------------------------------------------------------------------------------------------
  // Sign-in (S-A01, BR-65) and join (S-A06, BR-66)
  // ----------------------------------------------------------------------------------------------

  async signIn(
    input: { email: string; password: string },
    meta: RequestMeta,
  ): Promise<
    | { status: 'SIGNED_IN'; session: SignedIn }
    | { status: 'JOIN_AVAILABLE'; ticket: string; schoolName: string }
  > {
    const tenantId = requireTenantId();
    this.limiter.enforce([
      [`signin:ip:${meta.ip ?? 'unknown'}`, RATE_RULES.signInPerIp],
      [`signin:account:${input.email}`, RATE_RULES.signInPerAccount],
      [`signin:tenant:${tenantId}`, RATE_RULES.signInPerTenant],
    ]);

    const [account] = await this.lookup(input.email);
    if (account === undefined || account.password_hash === null) {
      await verifyPassword(await decoyPasswordHash(), input.password); // same work as a real check
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (account.locked_until !== null && account.locked_until.getTime() > Date.now()) {
      await verifyPassword(await decoyPasswordHash(), input.password);
      const retryAfter = Math.ceil((account.locked_until.getTime() - Date.now()) / 1000);
      throw new AppError('RATE_LIMITED', {
        detail: `Too many attempts. Try again in ${retryAfter} seconds.`,
        extensions: { retryAfter },
      });
    }

    const passwordOk = await verifyPassword(account.password_hash, input.password);
    if (!passwordOk || account.status !== 'ACTIVE') {
      if (!passwordOk) await this.recordFailure(account.user_id, account.failed_count ?? 0);
      throw new AppError('INVALID_CREDENTIALS');
    }
    this.limiter.reset(`signin:account:${input.email}`);

    return this.tenantDb.runAs(account.user_id, async (tx) => {
      await tx.credential.update({
        where: { userId: account.user_id },
        data: { failedCount: 0, lockedUntil: null },
      });
      const membership = await tx.tenantMembership.findFirst({
        where: { userId: account.user_id },
        select: { id: true, status: true, roles: { select: { role: true } } },
      });
      if (membership === null) {
        // BR-66: valid credentials, not yet a member. Offer "Join" only where sign-ups are open.
        if (!(await this.registrationOpenFor(tx, input.email))) throw new AppError('INVALID_CREDENTIALS');
        const ticket: JoinTicket = {
          userId: account.user_id,
          tenantId,
          expiresAt: Date.now() + JOIN_TICKET_TTL_MS,
        };
        return {
          status: 'JOIN_AVAILABLE' as const,
          ticket: this.box.sealText(JSON.stringify(ticket), 'join-ticket'),
          schoolName: await this.schoolName(tx),
        };
      }
      // BR-65: a suspended or revoked membership fails exactly like a wrong password.
      if (membership.status !== 'ACTIVE') throw new AppError('INVALID_CREDENTIALS');
      const roles = membership.roles.map((r) => r.role).filter(isRole);
      const session = await this.sessions.create(tx, {
        tenantId,
        userId: account.user_id,
        membershipId: membership.id,
        roles,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await this.audit.record(tx, {
        action: 'auth.signed_in',
        entityType: 'session',
        entityId: session.sessionId,
        actorId: account.user_id,
      });
      return {
        status: 'SIGNED_IN' as const,
        session: { token: session.token, maxAgeSeconds: session.maxAgeSeconds },
      };
    });
  }

  /** "Join *School*" after signing in with an existing account (BR-66). */
  async join(ticketText: string, meta: RequestMeta): Promise<SignedIn> {
    const tenantId = requireTenantId();
    let ticket: JoinTicket;
    try {
      ticket = JSON.parse(this.box.openText(ticketText, 'join-ticket')) as JoinTicket;
    } catch {
      throw new AppError('TOKEN_INVALID');
    }
    if (ticket.tenantId !== tenantId || ticket.expiresAt < Date.now()) throw new AppError('TOKEN_INVALID');

    return this.tenantDb.runAs(ticket.userId, async (tx) => {
      const account = await tx.userAccount.findUnique({
        where: { id: ticket.userId },
        select: { email: true, status: true },
      });
      if (account === null || account.status !== 'ACTIVE') throw new AppError('TOKEN_INVALID');
      if (!(await this.registrationOpenFor(tx, account.email))) throw new AppError('REGISTRATION_CLOSED');
      const existing = await tx.tenantMembership.findFirst({
        where: { userId: ticket.userId },
        select: { id: true },
      });
      if (existing !== null) throw new AppError('TOKEN_INVALID');
      await enforceLimit(tx, 'activeLearners', { box: this.box });
      const membership = await tx.tenantMembership.create({
        data: { tenantId, userId: ticket.userId, status: 'ACTIVE', joinedAt: new Date() },
        select: { id: true },
      });
      await tx.membershipRole.create({ data: { tenantId, membershipId: membership.id, role: 'LEARNER' } });
      await this.audit.record(tx, {
        action: 'membership.joined',
        entityType: 'membership',
        entityId: membership.id,
        actorId: ticket.userId,
      });
      const session = await this.sessions.create(tx, {
        tenantId,
        userId: ticket.userId,
        membershipId: membership.id,
        roles: ['LEARNER'],
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { token: session.token, maxAgeSeconds: session.maxAgeSeconds };
    });
  }

  async signOut(actor: TenantActor): Promise<void> {
    await this.tenantDb.run(async (tx) => {
      await tx.session.deleteMany({ where: { id: actor.sessionId } });
      await this.audit.record(tx, {
        action: 'auth.signed_out',
        entityType: 'session',
        entityId: actor.sessionId,
        actorId: actor.userId,
      });
    });
  }

  // ----------------------------------------------------------------------------------------------
  // Email verification (S-A03, S-A04)
  // ----------------------------------------------------------------------------------------------

  /** Confirms the email; signs the person in when the link was requested from this school. */
  async verifyEmail(token: string, meta: RequestMeta): Promise<{ session: SignedIn | null }> {
    this.limiter.enforce([[`token:ip:${meta.ip ?? 'unknown'}`, RATE_RULES.tokenPerIp]]);
    const redeemed = await this.redeem(token, 'VERIFY_EMAIL');
    const tenantId = requireTenantId();
    return this.tenantDb.runAs(redeemed.userId, async (tx) => {
      await tx.userAccount.update({
        where: { id: redeemed.userId },
        data: { emailVerifiedAt: new Date(), updatedAt: new Date() },
      });
      if (redeemed.contextTenantId !== tenantId) return { session: null };
      const membership = await tx.tenantMembership.findFirst({
        where: { userId: redeemed.userId, status: 'ACTIVE' },
        select: { id: true, roles: { select: { role: true } } },
      });
      if (membership === null) return { session: null };
      const session = await this.sessions.create(tx, {
        tenantId,
        userId: redeemed.userId,
        membershipId: membership.id,
        roles: membership.roles.map((r) => r.role).filter(isRole),
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await this.audit.record(tx, {
        action: 'account.email_verified',
        entityType: 'membership',
        entityId: membership.id,
        actorId: redeemed.userId,
      });
      return { session: { token: session.token, maxAgeSeconds: session.maxAgeSeconds } };
    });
  }

  async resendVerification(actor: TenantActor, meta: RequestMeta): Promise<void> {
    this.limiter.enforce([[`email:account:${actor.userId}`, RATE_RULES.emailPerAccount]]);
    const tenantId = requireTenantId();
    await this.tenantDb.run(async (tx) => {
      const account = await tx.userAccount.findUnique({
        where: { id: actor.userId },
        select: { email: true, displayName: true, emailVerifiedAt: true },
      });
      if (account === null || account.emailVerifiedAt !== null) return;
      const verify = issueToken();
      await tx.oneTimeToken.create({
        data: {
          userId: actor.userId,
          purpose: 'VERIFY_EMAIL',
          tokenHash: verify.hash,
          contextTenantId: tenantId,
          expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
        },
      });
      await queueEmail(tx, this.box, {
        template: 'verify-email',
        to: account.email,
        vars: {
          schoolName: await this.schoolName(tx),
          displayName: account.displayName,
          link: await this.link(meta.host, `/verify-email#token=${verify.token}`),
        },
      });
    });
  }

  // ----------------------------------------------------------------------------------------------
  // Password reset and change (S-A05; BR-69)
  // ----------------------------------------------------------------------------------------------

  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    this.limiter.enforce([
      [`email:ip:${meta.ip ?? 'unknown'}`, RATE_RULES.emailPerIp],
      [`email:account:${email}`, RATE_RULES.emailPerAccount],
    ]);
    const [account] = await this.lookup(email);
    if (account === undefined || account.status !== 'ACTIVE') return; // generic 202 either way
    const tenantId = requireTenantId();
    const reset = issueToken();
    await this.tenantDb.runAs(account.user_id, async (tx) => {
      await tx.oneTimeToken.create({
        data: {
          userId: account.user_id,
          purpose: 'RESET_PASSWORD',
          tokenHash: reset.hash,
          contextTenantId: tenantId,
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
        },
      });
      await queueEmail(tx, this.box, {
        template: 'reset-password',
        to: email,
        vars: {
          schoolName: await this.schoolName(tx),
          link: await this.link(meta.host, `/reset-password#token=${reset.token}`),
        },
      });
    });
  }

  /** Sets a new password and signs the person out everywhere (BR-69). */
  async resetPassword(input: { token: string; password: string }, meta: RequestMeta): Promise<void> {
    this.limiter.enforce([[`token:ip:${meta.ip ?? 'unknown'}`, RATE_RULES.tokenPerIp]]);
    if (!isWellFormedToken(input.token)) throw new AppError('TOKEN_INVALID');
    // Validate before redeeming, so a rejected password doesn't burn the link.
    await this.assertPasswordAcceptable(input.password, undefined, 'password');
    const redeemed = await this.redeem(input.token, 'RESET_PASSWORD');
    const passwordHash = await hashPassword(input.password);
    await this.tenantDb.runAs(redeemed.userId, async (tx) => {
      const account = await tx.userAccount.findUnique({
        where: { id: redeemed.userId },
        select: { email: true, emailVerifiedAt: true },
      });
      if (account === null) throw new AppError('TOKEN_INVALID');
      await tx.credential.update({
        where: { userId: redeemed.userId },
        data: { passwordHash, passwordChangedAt: new Date(), failedCount: 0, lockedUntil: null },
      });
      // The reset link proves control of the inbox.
      if (account.emailVerifiedAt === null) {
        await tx.userAccount.update({
          where: { id: redeemed.userId },
          data: { emailVerifiedAt: new Date() },
        });
      }
      await tx.$queryRaw`SELECT revoke_user_sessions_everywhere(NULL::uuid)`;
      await queueEmail(tx, this.box, {
        template: 'password-changed',
        to: account.email,
        vars: { schoolName: await this.schoolName(tx) },
      });
      await this.audit.record(tx, {
        action: 'account.password_reset',
        entityType: 'account',
        entityId: redeemed.userId,
        actorId: redeemed.userId,
      });
    });
  }

  /** Changes the password, keeping this session and ending all others in every school (BR-69). */
  async changePassword(
    actor: TenantActor,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    this.limiter.enforce([[`signin:account:${actor.userId}`, RATE_RULES.signInPerAccount]]);
    const credential = await this.tenantDb.run((tx) =>
      tx.credential.findUnique({ where: { userId: actor.userId }, select: { passwordHash: true } }),
    );
    if (credential === null || !(await verifyPassword(credential.passwordHash, input.currentPassword))) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [
          { field: 'currentPassword', code: 'incorrect', message: 'Your current password is incorrect' },
        ],
      });
    }
    const account = await this.tenantDb.run((tx) =>
      tx.userAccount.findUnique({ where: { id: actor.userId }, select: { email: true } }),
    );
    await this.assertPasswordAcceptable(input.newPassword, account?.email, 'newPassword');
    const passwordHash = await hashPassword(input.newPassword);
    await this.tenantDb.run(async (tx) => {
      await tx.credential.update({
        where: { userId: actor.userId },
        data: { passwordHash, passwordChangedAt: new Date(), failedCount: 0, lockedUntil: null },
      });
      await tx.$queryRaw`SELECT revoke_user_sessions_everywhere(${actor.sessionId}::uuid)`;
      if (account !== null) {
        await queueEmail(tx, this.box, {
          template: 'password-changed',
          to: account.email,
          vars: { schoolName: await this.schoolName(tx) },
        });
      }
      await this.audit.record(tx, {
        action: 'account.password_changed',
        entityType: 'account',
        entityId: actor.userId,
        actorId: actor.userId,
      });
    });
  }

  // ----------------------------------------------------------------------------------------------
  // Me, sessions, schools (S-L account; BR-68, BR-69)
  // ----------------------------------------------------------------------------------------------

  async me(actor: TenantActor): Promise<MeResponse> {
    // A support session has no account in this school: it describes the staff member and the grant.
    if (actor.support !== undefined) {
      return {
        user: {
          id: actor.userId,
          email: '',
          displayName: actor.support.staffName,
          emailVerified: true,
          locale: 'en',
        },
        membership: { id: actor.membershipId, roles: [...actor.roles] },
        allowedActions: allowedActions(actor),
        support: {
          staffName: actor.support.staffName,
          scope: actor.support.scope,
          expiresAt: actor.support.expiresAt.toISOString(),
        },
      };
    }
    const account = await this.tenantDb.run((tx) =>
      tx.userAccount.findUnique({
        where: { id: actor.userId },
        select: { id: true, email: true, displayName: true, emailVerifiedAt: true, defaultLocale: true },
      }),
    );
    if (account === null) throw new AppError('UNAUTHENTICATED');
    return {
      user: {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        emailVerified: account.emailVerifiedAt !== null,
        locale: account.defaultLocale,
      },
      membership: { id: actor.membershipId, roles: [...actor.roles] },
      allowedActions: allowedActions(actor),
      support: null,
    };
  }

  /** The person's sessions in THIS school (other schools' sessions are invisible here, by RLS). */
  async listSessions(actor: TenantActor) {
    const sessions = await this.tenantDb.run((tx) =>
      tx.session.findMany({
        where: { userId: actor.userId },
        orderBy: { lastSeenAt: 'desc' },
        select: { id: true, createdAt: true, lastSeenAt: true, userAgent: true },
      }),
    );
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        current: s.id === actor.sessionId,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        userAgent: s.userAgent,
      })),
    };
  }

  async endSession(actor: TenantActor, sessionId: string): Promise<void> {
    const ended = await this.tenantDb.run((tx) =>
      tx.session.deleteMany({ where: { id: sessionId, userId: actor.userId } }),
    );
    if (ended.count === 0) throw new AppError('NOT_FOUND');
  }

  /** "Sign out everywhere": every session of this account, in every school (BR-69). */
  async endAllSessions(actor: TenantActor): Promise<void> {
    await this.tenantDb.run(async (tx) => {
      await tx.$queryRaw`SELECT revoke_user_sessions_everywhere(NULL::uuid)`;
      await this.audit.record(tx, {
        action: 'auth.signed_out_everywhere',
        entityType: 'account',
        entityId: actor.userId,
        actorId: actor.userId,
      });
    });
  }

  async mySchools(actor: TenantActor): Promise<MySchoolsResponse> {
    const tenantId = requireTenantId();
    const rows = await this.tenantDb.run(
      (tx) =>
        tx.$queryRaw<
          { tenant_id: string; tenant_name: string; primary_host: string | null; roles: string[] }[]
        >`
        SELECT tenant_id, tenant_name, primary_host, roles::text[] AS roles FROM my_memberships()`,
    );
    void actor;
    return {
      schools: rows.map((row) => ({
        tenantId: row.tenant_id,
        name: row.tenant_name,
        host: row.primary_host,
        roles: row.roles.filter(isRole),
        current: row.tenant_id === tenantId,
      })),
    };
  }

  /** Mints a 60-second, single-use hand-off to another of the caller's schools (BR-68). */
  async createHandoff(actor: TenantActor, targetTenantId: string): Promise<{ url: string }> {
    const { schools } = await this.mySchools(actor);
    const target = schools.find((school) => school.tenantId === targetTenantId && !school.current);
    if (target === undefined || target.host === null) throw new AppError('NOT_FOUND');
    const handoff = issueToken();
    await this.tenantDb.run((tx) =>
      tx.tenantHandoff.create({
        data: {
          userId: actor.userId,
          targetTenantId,
          tokenHash: handoff.hash,
          expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
        },
      }),
    );
    return { url: `${this.schoolUrl(target.host)}/switch#token=${handoff.token}` };
  }

  /** On the target host: exchanges the hand-off and re-checks the membership here (BR-68). */
  async exchangeHandoff(token: string, meta: RequestMeta): Promise<SignedIn> {
    this.limiter.enforce([[`token:ip:${meta.ip ?? 'unknown'}`, RATE_RULES.tokenPerIp]]);
    if (!isWellFormedToken(token)) throw new AppError('TOKEN_INVALID');
    const tenantId = requireTenantId();
    return this.tenantDb.run(async (tx) => {
      const rows = await tx.$queryRaw<{ user_id: string | null }[]>`
        SELECT exchange_handoff(${hashToken(token)}) AS user_id`;
      const userId = rows[0]?.user_id ?? null;
      if (userId === null) throw new AppError('TOKEN_INVALID');
      const membership = await tx.tenantMembership.findFirst({
        where: { userId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
        select: { id: true, roles: { select: { role: true } } },
      });
      if (membership === null) throw new AppError('TOKEN_INVALID');
      const session = await this.sessions.create(tx, {
        tenantId,
        userId,
        membershipId: membership.id,
        roles: membership.roles.map((r) => r.role).filter(isRole),
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await this.audit.record(tx, {
        action: 'auth.switched_in',
        entityType: 'session',
        entityId: session.sessionId,
        actorId: userId,
      });
      return { token: session.token, maxAgeSeconds: session.maxAgeSeconds };
    });
  }

  /** Leaves the current school (not allowed for the last owner, BR-58). */
  async leaveSchool(actor: TenantActor): Promise<void> {
    await this.tenantDb.run(async (tx) => {
      if (actor.roles.includes('TENANT_OWNER') && (await this.activeOwnerCount(tx)) <= 1) {
        throw new AppError('LAST_OWNER');
      }
      await tx.tenantMembership.update({
        where: { id: actor.membershipId },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedBy: actor.userId,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        action: 'membership.left',
        entityType: 'membership',
        entityId: actor.membershipId,
        actorId: actor.userId,
      });
    });
  }

  // ----------------------------------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------------------------------

  async activeOwnerCount(tx: TenantTx): Promise<number> {
    return tx.membershipRole.count({ where: { role: 'TENANT_OWNER', membership: { status: 'ACTIVE' } } });
  }

  async assertPasswordAcceptable(password: string, email: string | undefined, field: string): Promise<void> {
    const problem = await passwordProblem(password, email === undefined ? {} : { email }, this.breached);
    if (problem !== null) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field, code: problem.toLowerCase(), message: passwordMessages[problem] }],
      });
    }
  }

  /** The school's display name (published branding, else its name). */
  async schoolName(tx: TenantTx): Promise<string> {
    const tenant = await tx.tenant.findUnique({
      where: { id: requireTenantId() },
      select: { name: true, branding: { select: { displayName: true, status: true } } },
    });
    return tenant?.branding?.status === 'PUBLISHED'
      ? tenant.branding.displayName
      : (tenant?.name ?? 'StudyHub');
  }

  /** An absolute link on the school's primary host. */
  async link(requestHost: string, path: string): Promise<string> {
    const resolved = await this.resolver.resolve(requestHost);
    return `${this.schoolUrl(resolved?.primaryHost ?? requestHost.replace(/:\d+$/, ''))}${path}`;
  }

  schoolUrl(host: string): string {
    return this.config.get('SCHOOL_URL_TEMPLATE').replace('{host}', host);
  }

  private lookup(email: string): Promise<AuthLookupRow[]> {
    return this.prisma.$queryRaw<AuthLookupRow[]>`SELECT * FROM auth_lookup(${email})`;
  }

  private async redeem(
    token: string,
    purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD',
  ): Promise<{ userId: string; contextTenantId: string | null }> {
    if (!isWellFormedToken(token)) throw new AppError('TOKEN_INVALID');
    const rows = await this.prisma.$queryRaw<{ user_id: string; context_tenant_id: string | null }[]>`
      SELECT user_id, context_tenant_id FROM redeem_one_time_token(${hashToken(token)}, ${purpose}::"TokenPurpose")`;
    const row = rows[0];
    if (row === undefined) throw new AppError('TOKEN_INVALID');
    return { userId: row.user_id, contextTenantId: row.context_tenant_id };
  }

  private async recordFailure(userId: string, previousFailures: number): Promise<void> {
    const failures = previousFailures + 1;
    await this.tenantDb.runAs(userId, async (tx) => {
      await tx.credential.update({
        where: { userId },
        data: {
          failedCount: failures,
          ...(failures >= LOCK_AFTER_FAILURES && {
            lockedUntil: new Date(Date.now() + LOCK_MS),
            failedCount: 0,
          }),
        },
      });
      // Only a member's failed sign-in is the school's business (its audit log).
      const member = await tx.tenantMembership.findFirst({ where: { userId }, select: { id: true } });
      if (member !== null) {
        await this.audit.record(tx, {
          action: 'auth.sign_in_failed',
          entityType: 'membership',
          entityId: member.id,
        });
      }
    });
  }

  /** BR-57: OPEN (default), INVITE_ONLY, or EMAIL_DOMAIN with an allowlist. */
  private async registrationOpenFor(tx: TenantTx, email: string): Promise<boolean> {
    // F37: a school being set up shows "coming soon"; only invited staff join it.
    if (currentContext()?.tenantStatus === 'PROVISIONING') return false;
    const settings = await tx.tenantSetting.findMany({
      where: { key: { in: ['learnerRegistrationMode', 'allowedEmailDomains'] } },
      select: { key: true, value: true },
    });
    const value = (key: string) => settings.find((s) => s.key === key)?.value;
    const mode = value('learnerRegistrationMode') ?? 'OPEN';
    if (mode === 'OPEN') return true;
    if (mode !== 'EMAIL_DOMAIN') return false;
    const domains = Array.isArray(value('allowedEmailDomains'))
      ? (value('allowedEmailDomains') as unknown[])
      : [];
    const domain = email.split('@')[1]?.toLowerCase();
    return domains.some((d) => typeof d === 'string' && d.toLowerCase() === domain);
  }

  private async assertRegistrationAllowed(email: string): Promise<void> {
    const open = await this.tenantDb.run((tx) => this.registrationOpenFor(tx, email));
    // BR-49: checked before the email is looked up, so a full school answers the same for every email.
    if (open) {
      await this.tenantDb.run((tx) => enforceLimit(tx, 'activeLearners'));
      return;
    }
    const mode = await this.tenantDb.run((tx) =>
      tx.tenantSetting.findFirst({ where: { key: 'learnerRegistrationMode' }, select: { value: true } }),
    );
    if (mode?.value === 'EMAIL_DOMAIN') {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'email', code: 'domain_not_allowed', message: 'Use your school email address' }],
      });
    }
    throw new AppError('REGISTRATION_CLOSED');
  }
}
