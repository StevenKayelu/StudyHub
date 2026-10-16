import { can, currentActor, type TenantActor } from '../../identity';
import { AppError } from '../../platform';

/** The signed-in actor (member or support session), or 401. */
export function requireActor(): TenantActor {
  const actor = currentActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

/** School owners and administrators (support sessions act as administrators). */
export function requireAdmin(actor: TenantActor): void {
  if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
}

/** Owner-only actions (F46 export and offboarding, domains, billing, go-live). Never a support session. */
export function requireOwner(actor: TenantActor): void {
  if (actor.support !== undefined || !actor.roles.includes('TENANT_OWNER')) throw new AppError('FORBIDDEN');
}

/** The actor is a real member of the school (not a support session). */
export function requireMember(actor: TenantActor): void {
  if (actor.support !== undefined) throw new AppError('SUPPORT_ACTION_EXCLUDED');
}
