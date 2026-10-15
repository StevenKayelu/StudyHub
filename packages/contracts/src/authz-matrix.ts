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
