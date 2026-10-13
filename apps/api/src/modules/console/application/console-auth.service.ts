import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ConsoleMeResponse, StaffListResponse } from '@studyhub/contracts';

import {
  AppError,
  base32Encode,
  currentContext,
  decoyPasswordHash,
  generateTotpSecret,
  hashRecoveryCode,
  hashToken,
  issueToken,
  isWellFormedToken,
  otpauthUri,
  RATE_RULES,
  RateLimiter,
  SecretBox,
  TenantDb,
  toBytes,
  type TenantTx,
  verifyPassword,
  verifyTotp,
} from '../../platform';

const MINUTE = 60_000;
/** Console sessions: idle 30 minutes, absolute 12 hours (04 §17.5). */
export const CONSOLE_IDLE_MS = 30 * MINUTE;
export const CONSOLE_ABSOLUTE_MS = 12 * 60 * MINUTE;
/** A re-authentication covers sensitive actions for this long. */
export const REAUTH_VALID_MS = 5 * MINUTE;
/** A session that has not passed TOTP may only enrol or verify, for this long. */
const PARTIAL_SESSION_MS = 10 * MINUTE;
const LOCK_AFTER_FAILURES = 5;
const LOCK_MS = 30 * MINUTE;
const RECOVERY_CODES = 8;

export type PlatformRole = 'PLATFORM_OWNER' | 'PLATFORM_OPERATOR' | 'PLATFORM_SUPPORT';

export interface ConsoleActor {
  userId: string;
  sessionId: string;
  role: PlatformRole;
  email: string;
  displayName: string;
  /** False until the second factor is verified in this session. */
  mfaVerified: boolean;
  totpEnabled: boolean;
  reauthAt: Date | null;
}

const totpContext = (userId: string) => `platform-totp:${userId}`;

/**
 * Platform (console) realm authentication: email + password + MANDATORY TOTP; separate tables,
 * cookie and host from schools. Every query runs in a console transaction (app.realm = 'platform'),
 * which is the only place platform rows are visible.
 */
@Injectable()
export class ConsoleAuthService {
  constructor(
    private readonly db: TenantDb,
    private readonly box: SecretBox,
    private readonly limiter: RateLimiter,
  ) {}

  /** Step 1: password. Returns a partial session that can only enrol or verify TOTP. */
  async signIn(
    input: { email: string; password: string },
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ token: string; next: 'ENROL_TOTP' | 'VERIFY_TOTP' }> {
    this.limiter.enforce([
      [`console:ip:${meta.ip ?? 'unknown'}`, RATE_RULES.consoleSignInPerIp],
      [`console:account:${input.email}`, RATE_RULES.consoleSignInPerAccount],
    ]);
    const staff = await this.db.runPlatform((tx) =>
      tx.platformUser.findUnique({
        where: { email: input.email },
        select: {
          id: true,
          status: true,
          credential: {
            select: { passwordHash: true, failedCount: true, lockedUntil: true, totpEnabledAt: true },
          },
        },
      }),
    );
    const credential = staff?.credential ?? null;
    if (staff === null || credential === null) {
      await verifyPassword(await decoyPasswordHash(), input.password);
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (credential.lockedUntil !== null && credential.lockedUntil.getTime() > Date.now()) {
      await verifyPassword(await decoyPasswordHash(), input.password);
      throw new AppError('INVALID_CREDENTIALS');
    }
    const ok = await verifyPassword(credential.passwordHash, input.password);
    if (!ok || staff.status !== 'ACTIVE') {
      if (!ok) {
        const failures = credential.failedCount + 1;
        await this.db.runPlatform(async (tx) => {
          await tx.platformCredential.update({
            where: { userId: staff.id },
            data:
              failures >= LOCK_AFTER_FAILURES
                ? { failedCount: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
                : { failedCount: failures },
          });
          await this.auditTx(tx, {
            actorId: staff.id,
            action: 'console.sign_in_failed',
            entityType: 'platform_user',
            entityId: staff.id,
          });
        });
      }
      throw new AppError('INVALID_CREDENTIALS');
    }

    const { token, hash } = issueToken();
    const now = Date.now();
    await this.db.runPlatform(async (tx) => {
      await tx.platformCredential.update({
        where: { userId: staff.id },
        data: { failedCount: 0, lockedUntil: null },
      });
      await tx.platformSession.create({
        data: {
          userId: staff.id,
          tokenHash: hash,
          idleExpiresAt: new Date(now + PARTIAL_SESSION_MS),
          absoluteExpiresAt: new Date(now + CONSOLE_ABSOLUTE_MS),
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
      });
    });
    return { token, next: credential.totpEnabledAt === null ? 'ENROL_TOTP' : 'VERIFY_TOTP' };
  }

  /** The actor for a console cookie, or null (expired, unknown, disabled staff). */
  async authenticate(token: string): Promise<ConsoleActor | null> {
    if (!isWellFormedToken(token)) return null;
    return this.db.runPlatform(async (tx) => {
      const now = new Date();
      const session = await tx.platformSession.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
          id: true,
          idleExpiresAt: true,
          absoluteExpiresAt: true,
          lastSeenAt: true,
          mfaVerifiedAt: true,
          reauthAt: true,
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
              role: true,
              status: true,
              credential: { select: { totpEnabledAt: true } },
            },
          },
        },
      });
      if (session === null || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) return null;
      if (session.user.status !== 'ACTIVE') return null;
      const mfaVerified = session.mfaVerifiedAt !== null;
      if (mfaVerified && now.getTime() - session.lastSeenAt.getTime() > MINUTE) {
        await tx.platformSession.update({
          where: { id: session.id },
          data: {
            lastSeenAt: now,
            idleExpiresAt: new Date(
              Math.min(now.getTime() + CONSOLE_IDLE_MS, session.absoluteExpiresAt.getTime()),
            ),
          },
        });
      }
      return {
        userId: session.user.id,
        sessionId: session.id,
        role: session.user.role,
        email: session.user.email,
        displayName: session.user.displayName,
        mfaVerified,
        totpEnabled: (session.user.credential?.totpEnabledAt ?? null) !== null,
        reauthAt: session.reauthAt,
      };
    });
  }

  /** First sign-in: a new TOTP secret (stored encrypted, not active until confirmed). */
  async setupTotp(actor: ConsoleActor): Promise<{ secret: string; otpauthUri: string }> {
    if (actor.totpEnabled)
      throw new AppError('FORBIDDEN', { detail: 'Two-step verification is already set up.' });
    const secret = generateTotpSecret();
    await this.db.runPlatform((tx) =>
      tx.platformCredential.update({
        where: { userId: actor.userId },
        data: { totpSecretEnc: toBytes(this.box.seal(secret, totpContext(actor.userId))) },
      }),
    );
    return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, 'StudyHub console', actor.email) };
  }

  /** Confirms enrolment with a first code; returns single-use recovery codes (shown once). */
  async enableTotp(actor: ConsoleActor, code: string): Promise<{ recoveryCodes: string[] }> {
    if (actor.totpEnabled)
      throw new AppError('FORBIDDEN', { detail: 'Two-step verification is already set up.' });
    this.limiter.enforce([[`console:totp:${actor.sessionId}`, RATE_RULES.consoleTotpPerSession]]);
    const recoveryCodes = Array.from({ length: RECOVERY_CODES }, () => {
      const raw = randomBytes(5).toString('hex');
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    await this.db.runPlatform(async (tx) => {
      const credential = await tx.platformCredential.findUnique({
        where: { userId: actor.userId },
        select: { totpSecretEnc: true },
      });
      if (credential === null || credential.totpSecretEnc === null)
        throw new AppError('TOKEN_INVALID', { detail: 'Start the setup again.' });
      const secret = this.box.open(Buffer.from(credential.totpSecretEnc), totpContext(actor.userId));
      const step = verifyTotp(secret, code);
      if (step === null) throw this.wrongCode();
      const now = new Date();
      await tx.platformCredential.update({
        where: { userId: actor.userId },
        data: {
          totpEnabledAt: now,
          totpLastStep: BigInt(step),
          recoveryCodesHash: recoveryCodes.map(hashRecoveryCode),
        },
      });
      await this.completeMfa(tx, actor.sessionId, now);
      await this.auditTx(tx, {
        actorId: actor.userId,
        action: 'console.totp_enabled',
        entityType: 'platform_user',
        entityId: actor.userId,
      });
    });
    return { recoveryCodes };
  }

  /** Step 2 for enrolled staff, and re-authentication for sensitive actions: a TOTP or recovery code. */
  async verifySecondFactor(actor: ConsoleActor, code: string, purpose: 'sign-in' | 'reauth'): Promise<void> {
    if (!actor.totpEnabled) throw new AppError('MFA_REQUIRED');
    this.limiter.enforce([[`console:totp:${actor.sessionId}`, RATE_RULES.consoleTotpPerSession]]);
    await this.db.runPlatform(async (tx) => {
      const credential = await tx.platformCredential.findUnique({
        where: { userId: actor.userId },
        select: { totpSecretEnc: true, totpLastStep: true, recoveryCodesHash: true },
      });
      if (credential === null || credential.totpSecretEnc === null) throw new AppError('MFA_REQUIRED');
      const secret = this.box.open(Buffer.from(credential.totpSecretEnc), totpContext(actor.userId));
      const lastUsedStep = credential.totpLastStep === null ? null : Number(credential.totpLastStep);
      const step = /^\d{6}$/.test(code) ? verifyTotp(secret, code, { lastUsedStep }) : null;
      const now = new Date();
      if (step !== null) {
        await tx.platformCredential.update({
          where: { userId: actor.userId },
          data: { totpLastStep: BigInt(step) },
        });
      } else {
        const hashed = hashRecoveryCode(code);
        if (!credential.recoveryCodesHash.includes(hashed)) throw this.wrongCode();
        await tx.platformCredential.update({
          where: { userId: actor.userId },
          data: { recoveryCodesHash: credential.recoveryCodesHash.filter((h) => h !== hashed) },
        });
      }
      if (purpose === 'sign-in') {
        await this.completeMfa(tx, actor.sessionId, now);
        await this.auditTx(tx, {
          actorId: actor.userId,
          action: 'console.signed_in',
          entityType: 'platform_session',
          entityId: actor.sessionId,
        });
      } else {
        await tx.platformSession.update({ where: { id: actor.sessionId }, data: { reauthAt: now } });
        await this.auditTx(tx, {
          actorId: actor.userId,
          action: 'console.reauthenticated',
          entityType: 'platform_session',
          entityId: actor.sessionId,
        });
      }
    });
  }

  async signOut(actor: ConsoleActor): Promise<void> {
    await this.db.runPlatform(async (tx) => {
      await tx.platformSession.deleteMany({ where: { id: actor.sessionId } });
      await this.auditTx(tx, {
        actorId: actor.userId,
        action: 'console.signed_out',
        entityType: 'platform_session',
        entityId: actor.sessionId,
      });
    });
  }

  me(actor: ConsoleActor): ConsoleMeResponse {
    return {
      id: actor.userId,
      email: actor.email,
      displayName: actor.displayName,
      role: actor.role,
      reauthValidUntil:
        actor.reauthAt === null ? null : new Date(actor.reauthAt.getTime() + REAUTH_VALID_MS).toISOString(),
    };
  }

  // --- Staff (S-C07) ---------------------------------------------------------------------------

  async listStaff(): Promise<StaffListResponse> {
    const staff = await this.db.runPlatform((tx) =>
      tx.platformUser.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          email: true,
          displayName: true,
          role: true,
          status: true,
          credential: { select: { totpEnabledAt: true } },
        },
      }),
    );
    return {
      staff: staff.map((s) => ({
        id: s.id,
        email: s.email,
        displayName: s.displayName,
        role: s.role,
        status: s.status,
        totpEnabled: (s.credential?.totpEnabledAt ?? null) !== null,
      })),
    };
  }

  /** Sensitive: disables a staff account and ends its sessions. Owners only, after re-authentication. */
  async disableStaff(actor: ConsoleActor, staffId: string): Promise<void> {
    if (staffId === actor.userId)
      throw new AppError('FORBIDDEN', { detail: "You can't disable your own account." });
    await this.db.runPlatform(async (tx) => {
      const target = await tx.platformUser.findUnique({
        where: { id: staffId },
        select: { id: true, status: true },
      });
      if (target === null) throw new AppError('NOT_FOUND');
      await tx.platformUser.update({
        where: { id: staffId },
        data: { status: 'DISABLED', updatedAt: new Date(), version: { increment: 1 } },
      });
      await tx.platformSession.deleteMany({ where: { userId: staffId } });
      await this.auditTx(tx, {
        actorId: actor.userId,
        action: 'console.staff_disabled',
        entityType: 'platform_user',
        entityId: staffId,
        before: { status: target.status },
        after: { status: 'DISABLED' },
      });
    });
  }

  private async completeMfa(tx: TenantTx, sessionId: string, now: Date): Promise<void> {
    await tx.platformSession.update({
      where: { id: sessionId },
      data: {
        mfaVerifiedAt: now,
        reauthAt: now,
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + CONSOLE_IDLE_MS),
      },
    });
  }

  private wrongCode(): AppError {
    return new AppError('VALIDATION_FAILED', {
      errors: [
        {
          field: 'code',
          code: 'incorrect',
          message: "That code didn't work. Check your authenticator app and try again.",
        },
      ],
    });
  }

  private async auditTx(
    tx: TenantTx,
    entry: {
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.platformAuditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        requestId: currentContext()?.requestId ?? null,
        ...(entry.before !== undefined && { before: entry.before as object }),
        ...(entry.after !== undefined && { after: entry.after as object }),
      },
    });
  }
}
