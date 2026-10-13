/**
 * Tenant-realm authorization (blueprint 04 §8, §17.6). Roles come only from the actor's membership in
 * the CURRENT school; resources of another school never reach here (RLS returns nothing, so they are
 * 404). Framework-free: unit-tested on its own and mirrored by the authorization matrix.
 */
export const TENANT_ROLES = ['LEARNER', 'INSTRUCTOR', 'TENANT_ADMIN', 'TENANT_OWNER'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export interface TenantActor {
  userId: string;
  membershipId: string;
  sessionId: string;
  roles: readonly TenantRole[];
}

export type TenantAction =
  | 'learn.access'
  | 'studio.access'
  | 'admin.access'
  | 'team.view'
  | 'team.invite'
  | 'member.changeRoles'
  | 'member.remove';

const has = (actor: TenantActor, ...roles: TenantRole[]) => roles.some((role) => actor.roles.includes(role));

/** Whether the actor may perform `action` at all (role level). */
export function can(actor: TenantActor | null, action: TenantAction): boolean {
  if (actor === null) return false;
  switch (action) {
    case 'learn.access':
      return actor.roles.length > 0;
    case 'studio.access':
      return has(actor, 'INSTRUCTOR');
    case 'admin.access':
    case 'team.view':
    case 'team.invite':
    case 'member.changeRoles':
    case 'member.remove':
      return has(actor, 'TENANT_ADMIN', 'TENANT_OWNER');
  }
}

/** The actions the actor may perform, for `allowedActions` in responses (04 §8). */
export function allowedActions(actor: TenantActor | null): TenantAction[] {
  const all: TenantAction[] = [
    'learn.access',
    'studio.access',
    'admin.access',
    'team.view',
    'team.invite',
    'member.changeRoles',
    'member.remove',
  ];
  return all.filter((action) => can(actor, action));
}

/**
 * Which roles an actor may grant or take away. Only owners manage owners and admins; admins manage
 * learners and instructors. (BR-58's "at least one active owner" is enforced in the database.)
 */
export function canManageRole(actor: TenantActor, role: TenantRole): boolean {
  if (has(actor, 'TENANT_OWNER')) return true;
  if (has(actor, 'TENANT_ADMIN')) return role === 'LEARNER' || role === 'INSTRUCTOR';
  return false;
}

/** Whether the actor may change or remove a member who currently holds `targetRoles`. */
export function canManageMember(actor: TenantActor, targetRoles: readonly TenantRole[]): boolean {
  return targetRoles.every((role) => canManageRole(actor, role));
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * Session lifetimes (04 §8): learners and instructors idle 30 days / absolute 90 days; school
 * administrators and owners idle 12 hours / absolute 7 days.
 */
export function sessionLifetime(roles: readonly TenantRole[]): { idleMs: number; absoluteMs: number } {
  return roles.includes('TENANT_ADMIN') || roles.includes('TENANT_OWNER')
    ? { idleMs: 12 * HOUR, absoluteMs: 7 * DAY }
    : { idleMs: 30 * DAY, absoluteMs: 90 * DAY };
}
