import { describe, expect, it } from 'vitest';

import {
  allowedActions,
  can,
  canManageMember,
  canManageRole,
  sessionLifetime,
  type TenantActor,
} from './policy';

const actor = (...roles: TenantActor['roles'][number][]): TenantActor => ({
  userId: 'u',
  membershipId: 'm',
  sessionId: 's',
  roles,
});

describe('tenant policy', () => {
  it('denies everything to anonymous visitors', () => {
    expect(allowedActions(null)).toEqual([]);
  });

  it('gives each role its spaces', () => {
    expect(can(actor('LEARNER'), 'learn.access')).toBe(true);
    expect(can(actor('LEARNER'), 'studio.access')).toBe(false);
    expect(can(actor('LEARNER'), 'admin.access')).toBe(false);
    expect(can(actor('INSTRUCTOR'), 'studio.access')).toBe(true);
    expect(can(actor('TENANT_ADMIN'), 'admin.access')).toBe(true);
    expect(can(actor('TENANT_OWNER'), 'team.invite')).toBe(true);
    // Admin rights don't imply teaching rights.
    expect(can(actor('TENANT_ADMIN'), 'studio.access')).toBe(false);
  });

  it('lets only owners manage owners and admins', () => {
    expect(canManageRole(actor('TENANT_OWNER'), 'TENANT_OWNER')).toBe(true);
    expect(canManageRole(actor('TENANT_ADMIN'), 'TENANT_ADMIN')).toBe(false);
    expect(canManageRole(actor('TENANT_ADMIN'), 'INSTRUCTOR')).toBe(true);
    expect(canManageRole(actor('INSTRUCTOR'), 'LEARNER')).toBe(false);
    expect(canManageMember(actor('TENANT_ADMIN'), ['LEARNER', 'INSTRUCTOR'])).toBe(true);
    expect(canManageMember(actor('TENANT_ADMIN'), ['TENANT_ADMIN'])).toBe(false);
  });

  it('gives administrators shorter sessions', () => {
    expect(sessionLifetime(['LEARNER']).absoluteMs).toBe(90 * 86_400_000);
    expect(sessionLifetime(['LEARNER', 'TENANT_ADMIN']).idleMs).toBe(12 * 3_600_000);
  });
});
