import { AppError, currentContext, type RequestContext } from '../../platform';
import { type ConsoleActor, REAUTH_VALID_MS } from '../application/console-auth.service';

/** The console actor of each request (set by registerConsoleHook). */
export const actors = new WeakMap<RequestContext, ConsoleActor>();

export function consoleActor(): ConsoleActor | null {
  const context = currentContext();
  return context === undefined ? null : (actors.get(context) ?? null);
}

/** A console session that has passed TOTP. */
export function requireStaff(): ConsoleActor {
  const actor = consoleActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  if (!actor.mfaVerified) throw new AppError('MFA_REQUIRED');
  return actor;
}

/** A password-only (partial) session: may enrol or verify the second factor, nothing else. */
export function requirePartial(): ConsoleActor {
  const actor = consoleActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

/** Sensitive actions need a TOTP re-authentication within REAUTH_VALID_MS (04 §17.5). */
export function requireRecentReauth(actor: ConsoleActor): void {
  if (actor.reauthAt === null || Date.now() - actor.reauthAt.getTime() > REAUTH_VALID_MS) {
    throw new AppError('REAUTH_REQUIRED');
  }
}

export function requireRole(actor: ConsoleActor, ...roles: ConsoleActor['role'][]): void {
  if (!roles.includes(actor.role)) throw new AppError('FORBIDDEN');
}
