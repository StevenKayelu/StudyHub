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

/** Payment accounts (F45): the school owner only. */
const ownerOnly = (status: number) =>
  ({
    anonymous: 401,
    learner: 403,
    instructor: 403,
    admin: 403,
    owner: status,
    otherSchool: 401,
    staff: 401,
  }) as const;

/** An id that exists in no school, for request bodies (paths use `{missing}`). */
const MISSING_ID = '00000000-0000-4000-8000-00000000dead';

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
  // M5: Studio is for instructors (an administrator is not automatically an instructor).
  {
    method: 'GET',
    path: '/api/v1/studio/courses',
    expect: {
      anonymous: 401,
      learner: 403,
      instructor: 200,
      admin: 403,
      owner: 403,
      otherSchool: 401,
      staff: 401,
    },
  },
  {
    method: 'GET',
    path: '/api/v1/studio/courses/{missing}',
    expect: {
      anonymous: 401,
      learner: 404,
      instructor: 404,
      admin: 404,
      owner: 404,
      otherSchool: 401,
      staff: 401,
    },
  },
  { method: 'GET', path: '/api/v1/admin/course-reviews', expect: adminOnly(200) },
  { method: 'GET', path: '/api/v1/admin/instructor-applications', expect: adminOnly(200) },
  {
    method: 'POST',
    path: '/api/v1/admin/categories',
    body: { name: 'Matrix category' },
    expect: adminOnly(201),
  },
  // The public catalogue answers everyone on a PUBLIC school (cookies from elsewhere are simply ignored).
  {
    method: 'GET',
    path: '/api/v1/courses',
    expect: {
      anonymous: 200,
      learner: 200,
      instructor: 200,
      admin: 200,
      owner: 200,
      otherSchool: 200,
      staff: 200,
    },
  },
  {
    method: 'POST',
    path: '/api/v1/uploads',
    body: { purpose: 'LESSON_FILE', fileName: 'm.pdf', mime: 'application/pdf', sizeBytes: 100 },
    expect: {
      anonymous: 401,
      learner: 403,
      instructor: 201,
      admin: 403,
      owner: 403,
      otherSchool: 401,
      staff: 401,
    },
  },
  // M6 learning: My learning and the player need a member of this school; a course that doesn't exist
  // here (or belongs to another school) is 404 for everyone signed in.
  { method: 'GET', path: '/api/v1/me/enrollments', expect: signedInOnly(200) },
  { method: 'GET', path: '/api/v1/learn/courses/{missing}', expect: signedInOnly(404) },
  { method: 'POST', path: '/api/v1/courses/no-such-course/enrol', expect: signedInOnly(404) },
  {
    method: 'PUT',
    path: '/api/v1/learn/lessons/{missing}/progress',
    body: { positionSeconds: 10 },
    expect: signedInOnly(404),
  },
  // Preview lessons are open to visitors, so a missing lesson is simply not found, for anyone.
  {
    method: 'GET',
    path: '/api/v1/learn/lessons/{missing}',
    expect: {
      anonymous: 404,
      learner: 404,
      instructor: 404,
      admin: 404,
      owner: 404,
      otherSchool: 404,
      staff: 404,
    },
  },
  { method: 'GET', path: '/api/v1/studio/courses/{missing}/learners', expect: signedInOnly(404) },
  { method: 'GET', path: '/api/v1/admin/courses/{missing}/enrollments', expect: adminOnly(404) },
  {
    method: 'POST',
    path: '/api/v1/admin/courses/{missing}/enrollments',
    body: { email: 'matrix-learner@example.com', reason: 'Scholarship' },
    expect: adminOnly(404),
  },
  {
    method: 'POST',
    path: '/api/v1/admin/enrollments/{missing}/revoke',
    body: { reason: 'Matrix check' },
    expect: adminOnly(404),
  },
  // M7 assessment: learners reach quizzes and attempts of their own school only; Studio's bank, quizzes and
  // grading belong to the course owner. Missing (or another school's) ids are 404 for everyone signed in.
  { method: 'GET', path: '/api/v1/me/assessments', expect: signedInOnly(200) },
  { method: 'GET', path: '/api/v1/learn/quizzes/{missing}', expect: signedInOnly(404) },
  { method: 'POST', path: '/api/v1/learn/quizzes/{missing}/attempts', expect: signedInOnly(404) },
  {
    method: 'PUT',
    path: '/api/v1/learn/attempts/{missing}/answers/{missing}',
    body: { response: { text: 'x' }, clientSeq: 1 },
    expect: signedInOnly(404),
  },
  { method: 'GET', path: '/api/v1/learn/attempts/{missing}/result', expect: signedInOnly(404) },
  { method: 'GET', path: '/api/v1/learn/courses/{missing}/practice', expect: signedInOnly(404) },
  { method: 'GET', path: '/api/v1/studio/courses/{missing}/questions', expect: signedInOnly(404) },
  {
    method: 'POST',
    path: '/api/v1/studio/courses/{missing}/quizzes',
    body: { title: 'Matrix quiz' },
    expect: signedInOnly(404),
  },
  { method: 'GET', path: '/api/v1/studio/courses/{missing}/grading-queue', expect: signedInOnly(404) },
  {
    method: 'PUT',
    path: '/api/v1/studio/attempts/{missing}/items/{missing}/grade',
    body: { points: 1 },
    expect: signedInOnly(404),
  },
  // M8 commerce: orders belong to their buyer (another school's or a missing order is 404); payment
  // accounts are the owner's; orders, exceptions and settings the administrators'; earnings need
  // revenue share (off by default: 403 FEATURE_NOT_ENABLED); payout methods are the instructor's.
  { method: 'POST', path: '/api/v1/orders', body: { courseId: MISSING_ID }, expect: signedInOnly(404) },
  { method: 'GET', path: '/api/v1/orders/{missing}', expect: signedInOnly(404) },
  {
    method: 'POST',
    path: '/api/v1/orders/{missing}/payments',
    body: { method: 'CARD' },
    expect: signedInOnly(404),
  },
  { method: 'POST', path: '/api/v1/orders/{missing}/refresh', expect: signedInOnly(404) },
  { method: 'POST', path: '/api/v1/orders/{missing}/cancel', expect: signedInOnly(404) },
  { method: 'GET', path: '/api/v1/me/orders', expect: signedInOnly(200) },
  { method: 'GET', path: '/api/v1/me/orders/{missing}/receipt', expect: signedInOnly(404) },
  { method: 'GET', path: '/api/v1/admin/payment-accounts', expect: ownerOnly(200) },
  { method: 'GET', path: '/api/v1/admin/payment-providers', expect: ownerOnly(200) },
  { method: 'POST', path: '/api/v1/admin/payment-accounts/{missing}/test', expect: ownerOnly(404) },
  { method: 'POST', path: '/api/v1/admin/payment-accounts/{missing}/activate', expect: ownerOnly(404) },
  { method: 'DELETE', path: '/api/v1/admin/payment-accounts/{missing}', expect: ownerOnly(404) },
  { method: 'GET', path: '/api/v1/admin/payment-accounts/{missing}/capabilities', expect: adminOnly(404) },
  { method: 'GET', path: '/api/v1/admin/settings', expect: adminOnly(200) },
  { method: 'GET', path: '/api/v1/admin/orders', expect: adminOnly(200) },
  { method: 'GET', path: '/api/v1/admin/orders/{missing}', expect: adminOnly(404) },
  {
    method: 'POST',
    path: '/api/v1/admin/orders/{missing}/refunds',
    body: { mode: 'MANUAL', reason: 'Matrix check', reference: 'MATRIX-1' },
    expect: adminOnly(404),
  },
  { method: 'GET', path: '/api/v1/admin/payment-exceptions', expect: adminOnly(200) },
  { method: 'POST', path: '/api/v1/admin/payments/{missing}/recheck', expect: adminOnly(404) },
  {
    method: 'POST',
    path: '/api/v1/admin/payments/{missing}/resolve',
    body: { decision: 'ACCEPT', note: 'Matrix check' },
    expect: adminOnly(404),
  },
  { method: 'GET', path: '/api/v1/admin/earnings', expect: adminOnly(403) },
  { method: 'GET', path: '/api/v1/admin/payouts', expect: adminOnly(403) },
  {
    method: 'GET',
    path: '/api/v1/me/payout-methods',
    expect: {
      anonymous: 401,
      learner: 403,
      instructor: 200,
      admin: 403,
      owner: 403,
      otherSchool: 401,
      staff: 401,
    },
  },
  {
    method: 'DELETE',
    path: '/api/v1/me/payout-methods/{missing}',
    expect: {
      anonymous: 401,
      learner: 403,
      instructor: 404,
      admin: 403,
      owner: 403,
      otherSchool: 401,
      staff: 401,
    },
  },
  // M9 school administration: owners and administrators; exports of the whole school, domains,
  // offboarding, billing and go-live are the owner's. Missing or other schools' ids are 404.
  { method: 'GET', path: '/api/v1/admin/branding', expect: adminOnly(200) },
  {
    method: 'POST',
    path: '/api/v1/admin/branding/validate-colour',
    body: { accentHex: '#1d5da6' },
    expect: adminOnly(200),
  },
  { method: 'GET', path: '/api/v1/admin/features', expect: adminOnly(200) },
  {
    method: 'PUT',
    path: '/api/v1/admin/features/practiceMode',
    body: { enabled: true },
    expect: adminOnly(204),
  },
  { method: 'GET', path: '/api/v1/admin/locales', expect: adminOnly(200) },
  { method: 'GET', path: '/api/v1/admin/users', expect: adminOnly(200) },
  { method: 'GET', path: '/api/v1/admin/users/{otherMembership}', expect: adminOnly(404) },
  {
    method: 'POST',
    path: '/api/v1/admin/users/{missing}/suspend',
    body: { reason: 'Matrix check' },
    expect: adminOnly(404),
  },
  { method: 'GET', path: '/api/v1/admin/queues/summary', expect: adminOnly(200) },
  {
    method: 'GET',
    path: '/api/v1/admin/reports/overview?from=2026-01-01&to=2026-01-31',
    expect: adminOnly(200),
  },
  { method: 'GET', path: '/api/v1/admin/exports', expect: adminOnly(200) },
  { method: 'GET', path: '/api/v1/admin/exports/{missing}', expect: adminOnly(404) },
  { method: 'POST', path: '/api/v1/admin/exports/tenant', expect: ownerOnly(201) },
  { method: 'GET', path: '/api/v1/admin/audit-log', expect: adminOnly(200) },
  { method: 'GET', path: '/api/v1/admin/support-access', expect: adminOnly(200) },
  {
    method: 'POST',
    path: '/api/v1/admin/support-access/{missing}/decision',
    body: { decision: 'APPROVE' },
    expect: adminOnly(404),
  },
  { method: 'GET', path: '/api/v1/admin/usage', expect: adminOnly(200) },
  { method: 'GET', path: '/api/v1/admin/onboarding', expect: adminOnly(200) },
  // The school is already live: the owner gets 409 INVALID_STATE, everyone else is refused first.
  { method: 'POST', path: '/api/v1/admin/onboarding/go-live', expect: ownerOnly(409) },
  { method: 'GET', path: '/api/v1/admin/domains', expect: adminOnly(200) },
  {
    method: 'POST',
    path: '/api/v1/admin/domains/change-requests',
    body: { requestedSlug: 'admin', reason: 'Matrix check' },
    expect: ownerOnly(422),
  },
  {
    method: 'POST',
    path: '/api/v1/admin/owners/transfer',
    body: { membershipId: MISSING_ID },
    expect: ownerOnly(404),
  },
  { method: 'GET', path: '/api/v1/admin/offboarding', expect: adminOnly(200) },
  {
    method: 'POST',
    path: '/api/v1/admin/offboarding',
    body: { confirmName: 'Not the school name' },
    expect: ownerOnly(422),
  },
  { method: 'GET', path: '/api/v1/admin/billing/statements', expect: ownerOnly(200) },
  { method: 'GET', path: '/api/v1/admin/reconciliation/settlements', expect: adminOnly(200) },
  { method: 'GET', path: '/api/v1/me/notifications', expect: signedInOnly(200) },
];

/** Console rows (M9): `manager` = owners and operators; `ownerConsole` = platform owners only. */
const manager = (status: number) =>
  ({ anonymous: 401, schoolSession: 401, partialStaff: 401, operator: status, owner: status }) as const;
const ownerConsole = (status: number) =>
  ({ anonymous: 401, schoolSession: 401, partialStaff: 401, operator: 403, owner: status }) as const;

export const CONSOLE_AUTHZ_MATRIX: readonly MatrixRow<ConsoleMatrixActor>[] = [
  { method: 'GET', path: '/console/overview', expect: manager(200) },
  { method: 'GET', path: '/console/metrics', expect: manager(200) },
  { method: 'GET', path: '/console/tenants', expect: manager(200) },
  { method: 'GET', path: '/console/tenants/{missing}', expect: manager(404) },
  {
    method: 'POST',
    path: '/console/tenants/{missing}/suspend',
    body: { reason: 'Matrix check' },
    expect: manager(404),
  },
  { method: 'GET', path: '/console/plans', expect: manager(200) },
  { method: 'POST', path: '/console/plans', body: {}, expect: ownerConsole(422) },
  { method: 'GET', path: '/console/settings', expect: ownerConsole(200) },
  { method: 'GET', path: '/console/audit-log', expect: ownerConsole(200) },
  { method: 'GET', path: '/console/statements', expect: manager(200) },
  { method: 'GET', path: '/console/domain-change-requests', expect: manager(200) },
  { method: 'GET', path: '/console/support-access', expect: manager(200) },
  { method: 'POST', path: '/console/support-access/emergency', body: {}, expect: ownerConsole(422) },
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
