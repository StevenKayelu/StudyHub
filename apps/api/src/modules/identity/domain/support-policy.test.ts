import { describe, expect, it } from 'vitest';

import { supportVerdict } from './support-policy';

describe('support sessions (F44, BR-47)', () => {
  it('reads are allowed in both scopes', () => {
    expect(supportVerdict('READ_ONLY', 'GET', '/api/v1/admin/users')).toBe('OK');
    expect(supportVerdict('READ_WRITE', 'GET', '/api/v1/admin/payment-accounts')).toBe('OK');
  });

  it('READ_ONLY refuses every write except ending the session', () => {
    expect(supportVerdict('READ_ONLY', 'PATCH', '/api/v1/admin/settings')).toBe('READ_ONLY');
    expect(supportVerdict('READ_ONLY', 'POST', '/api/v1/support/end')).toBe('OK');
  });

  it('READ_WRITE allows admin writes but never owners, payment accounts or domains', () => {
    expect(supportVerdict('READ_WRITE', 'PATCH', '/api/v1/admin/settings')).toBe('OK');
    expect(supportVerdict('READ_WRITE', 'POST', '/api/v1/admin/courses/x/unpublish')).toBe('OK');
    for (const path of [
      '/api/v1/admin/payment-accounts',
      '/api/v1/admin/payment-accounts/x/activate',
      '/api/v1/admin/domains/change-requests',
      '/api/v1/admin/owners/transfer',
      '/api/v1/admin/members/x/roles',
      '/api/v1/admin/invitations',
      '/api/v1/admin/support-access/x/revoke',
      '/api/v1/admin/offboarding',
      '/api/v1/admin/exports/tenant',
    ]) {
      expect(supportVerdict('READ_WRITE', 'POST', path), path).toBe('EXCLUDED');
    }
    expect(supportVerdict('READ_WRITE', 'PUT', '/api/v1/admin/members/x/roles?y=1')).toBe('EXCLUDED');
  });

  it('READ_WRITE refuses writes outside the admin area', () => {
    expect(supportVerdict('READ_WRITE', 'POST', '/api/v1/orders')).toBe('EXCLUDED');
    expect(supportVerdict('READ_WRITE', 'POST', '/api/v1/me/password')).toBe('EXCLUDED');
    expect(supportVerdict('READ_WRITE', 'PATCH', '/api/v1/studio/courses/x')).toBe('EXCLUDED');
  });
});
