/**
 * Authorization matrix (blueprint 04 §8, 07 M4 AC 5): endpoint × actor → expected HTTP status. The API
 * integration suite generates one test per cell, so a route whose guard drifts from this table fails CI.
 *
 * Actors (all requests are made on school A's host unless noted):
 * - anonymous: no cookie
 * - learner, instructor, admin, owner: a session of that role in school A
 * - otherSchool: an owner's session from school B, replayed on school A's host (BR-44)
 * - staff: a platform staff session (console cookie) sent to school A's host
 * Console rows are requested on the console host; `schoolSession` is school A's owner cookie there.
 *
 * Paths: `{otherMembership}` is a membership of school B (must be 404 in school A: RLS),
 * `{missing}` an id that exists nowhere.
 */
export type TenantMatrixActor =
  'anonymous' | 'learner' | 'instructor' | 'admin' | 'owner' | 'otherSchool' | 'staff';
export type ConsoleMatrixActor = 'anonymous' | 'schoolSession' | 'partialStaff' | 'operator' | 'owner';

export interface MatrixRow<A extends string> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  expect: Record<A, number>;
}

const signedInOnly = (status: number) =>
  ({
    anonymous: 401,
    learner: status,
    instructor: status,
    admin: status,
    owner: status,
    otherSchool: 401,
    staff: 401,
  }) as const;

const adminOnly = (status: number) =>
  ({
    anonymous: 401,
    learner: 403,
    instructor: 403,
    admin: status,
    owner: status,
    otherSchool: 401,
    staff: 401,
  }) as const;

export const TENANT_AUTHZ_MATRIX: readonly MatrixRow<TenantMatrixActor>[] = [
  { method: 'GET', path: '/api/v1/me', expect: signedInOnly(200) },
  { method: 'GET', path: '/api/v1/me/sessions', expect: signedInOnly(200) },
  { method: 'GET', path: '/api/v1/me/schools', expect: signedInOnly(200) },
  { method: 'DELETE', path: '/api/v1/me/sessions/{missing}', expect: signedInOnly(404) },
  { method: 'GET', path: '/api/v1/admin/team', expect: adminOnly(200) },
  {
    method: 'POST',
    path: '/api/v1/admin/invitations',
    body: { email: 'matrix-invitee@example.com', role: 'INSTRUCTOR' },
    expect: adminOnly(201),
  },
  // Only owners may invite administrators.
  {
    method: 'POST',
    path: '/api/v1/admin/invitations',
    body: { email: 'matrix-admin@example.com', role: 'TENANT_ADMIN' },
    expect: { ...adminOnly(201), admin: 403 },
  },
  { method: 'DELETE', path: '/api/v1/admin/invitations/{missing}', expect: adminOnly(404) },
  // Another school's member is invisible here: 404, never 403 (04 §17.6).
  { method: 'DELETE', path: '/api/v1/admin/members/{otherMembership}', expect: adminOnly(404) },
  {
    method: 'PUT',
    path: '/api/v1/admin/members/{otherMembership}/roles',
    body: { roles: ['LEARNER'] },
    expect: adminOnly(404),
  },
];

export const CONSOLE_AUTHZ_MATRIX: readonly MatrixRow<ConsoleMatrixActor>[] = [
  {
    method: 'GET',
    path: '/console/me',
    expect: { anonymous: 401, schoolSession: 401, partialStaff: 401, operator: 200, owner: 200 },
  },
  {
    method: 'GET',
    path: '/console/staff',
    expect: { anonymous: 401, schoolSession: 401, partialStaff: 401, operator: 200, owner: 200 },
  },
  // Sensitive: owners only, and only after a recent re-authentication (403 REAUTH_REQUIRED otherwise).
  {
    method: 'POST',
    path: '/console/staff/{missing}/disable',
    expect: { anonymous: 401, schoolSession: 401, partialStaff: 401, operator: 403, owner: 404 },
  },
];
