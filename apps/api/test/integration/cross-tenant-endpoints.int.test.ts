import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PAYMENT_GATEWAY, type PaymentGateway } from '../../src/modules/commerce';
import { listRoutes } from '../setup/routes';
import {
  foreignResponseMarkers,
  ISOLATION_PAYLOADS,
  isolationPayload,
  isReferenceValidationDenial,
} from '../setup/isolation-payloads';
import { type Harness, SCHOOLS, startHarness } from '../setup/school-harness';
import { tenantOwnedTables } from '../setup/tenancy-checks';
import { asTenant, seedFixtures } from '../setup/tenant-fixtures';

/**
 * T-ISO-22 (04 §17.13 item 3, M10 DoD 2): EVERY API endpoint, called by each role of school B on
 * school B's host with school A's real ids in the path and in the body, must
 *   1. never return school A's data (responses are scanned for school A's markers),
 *   2. never succeed (2xx) on a path that names a school A record, and
 *   3. never change school A's data (every school A row is hashed before and after the run).
 * Console routes do not exist on school hosts (M4 AC 3): each is called there and must be 404.
 * A new route without a mapping for its path parameters fails the coverage test below.
 */

/** Path parameter → the school A table whose id fills it, by the path segment before it. */
const ID_PARAMS: Record<string, string> = {
  'courses/:id': 'course',
  'courses/:slug': 'course:slug',
  'instructors/:slug': 'instructor_profile:slug',
  'instructors/:membershipId': 'tenant_membership',
  'lessons/:id': 'lesson',
  'lessons/:lessonId': 'lesson',
  'sections/:sectionId': 'section',
  'questions/:id': 'question',
  'quizzes/:id': 'quiz',
  'attempts/:id': 'attempt',
  'practice/:attemptId': 'attempt',
  'answers/:itemId': 'attempt_item',
  'items/:itemId': 'attempt_item',
  'orders/:id': 'order',
  'payments/:id': 'payment',
  'payment-accounts/:id': 'payment_account',
  'invitations/:id': 'invitation',
  'members/:membershipId': 'tenant_membership',
  'users/:membershipId': 'tenant_membership',
  'earnings/:membershipId': 'tenant_membership',
  'sessions/:sessionId': 'session',
  'sessions/:id': 'session',
  'payout-methods/:id': 'payout_method',
  'statements/:id': 'platform_statement',
  'exports/:id': 'data_export',
  'settlements/:id': 'settlement_report',
  'assets/:id': 'asset',
  'files/:assetId': 'asset',
  'brand/:assetId': 'asset',
  'uploads/:id': 'asset',
  'support-access/:id': 'support_access_grant',
  'change-requests/:id': 'domain_change_request',
  'enrollments/:id': 'enrollment',
  'categories/:id': 'category',
  'subjects/:id': 'subject',
  'schools/:tenantId': 'tenant',
  'phone/:paymentId': 'payment',
  ':accountId': 'payment_account',
  'fake-video/:providerVideoId': 'asset:providerVideoId',
};

/** Parameters that are not school records: fixed probe values. */
const VALUE_PARAMS: Record<string, string> = {
  ':page': 'terms',
  ':key': 'paidCourses',
  ':version': '1',
  ':provider': 'fake',
  ':decision': 'approve',
  ':transactionId': 'fake-transaction-probe',
};

/** Settlement items sit under a settlement report. */
const settlementItem = (route: string) => route.includes('/settlements/') && route.endsWith('/resolve');

/** Calls that end or replace the caller's own session: the actor signs in again afterwards. */
const ENDS_SESSION = /sign-out|\/sessions|password|handoff|support\/end|\/switch/;
const LEAVE_SCHOOL = 'POST /api/v1/me/schools/current/leave';

describe('every endpoint against another school’s ids (T-ISO-22)', () => {
  let harness: Harness;
  let appClient: Client;
  let acme: string;
  const ids: Record<string, string> = {};
  const markers: string[] = [];
  const actors: Record<string, { email?: string; cookie?: string }> = { anonymous: {} };

  /** Hash of every school A row, per tenant table (read as the table owner inside A's context). */
  async function snapshot(): Promise<Record<string, string>> {
    const tables = await tenantOwnedTables(harness.migrator);
    return asTenant(harness.migrator, acme, async () => {
      const result: Record<string, string> = {};
      for (const table of tables) {
        const { rows } = await harness.migrator.query<{ hash: string | null }>(
          `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS hash FROM "${table}" t WHERE t.tenant_id = $1`,
          [acme],
        );
        result[table] = rows[0]?.hash ?? '';
      }
      return result;
    });
  }

  function urlFor(route: string): { url: string; namesSchoolA: boolean } | null {
    const path = route.split(' ')[1]!;
    const segments = path.split('/');
    let namesSchoolA = false;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]!;
      if (!segment.startsWith(':')) continue;
      const before = segments[i - 1] ?? '';
      let value: string | undefined;
      if (segment === ':itemId' && settlementItem(route)) {
        value = ids.settlement_item;
        namesSchoolA = true;
      } else if (VALUE_PARAMS[segment] !== undefined) value = VALUE_PARAMS[segment];
      else {
        const table = ID_PARAMS[`${before}/${segment}`] ?? ID_PARAMS[segment];
        if (table === undefined) return null;
        value = ids[table];
        namesSchoolA = true;
      }
      if (value === undefined) return null;
      segments[i] = encodeURIComponent(value);
    }
    return { url: segments.join('/'), namesSchoolA };
  }

  /** A body naming school A records under every key the API uses for references. */
  const poisonBody = (email = 'probe@example.com') => ({
    courseId: ids.course,
    lessonId: ids.lesson,
    sectionId: ids.section,
    quizId: ids.quiz,
    questionId: ids.question,
    questionIds: [ids.question],
    items: [{ questionId: ids.question, points: 1 }],
    membershipId: ids.tenant_membership,
    orderId: ids.order,
    paymentId: ids.payment,
    paymentAccountId: ids.payment_account,
    assetId: ids.asset,
    coverAssetId: ids.asset,
    logoAssetId: ids.asset,
    categoryId: ids.category,
    subjectId: ids.subject,
    enrollmentId: ids.enrollment,
    tenantId: acme,
    title: 'Probe',
    name: 'Probe',
    email,
    reason: 'Cross-school isolation probe (T-ISO-22)',
    decision: 'APPROVE',
    role: 'LEARNER',
    roles: ['LEARNER'],
    enabled: true,
    method: 'MOBILE_MONEY',
    phone: '+260970000000',
  });

  beforeAll(async () => {
    harness = await startHarness();
    acme = harness.tenants.acme;
    appClient = await harness.database.connect(harness.database.appUrl);
    // School A gets one row of every tenant table; school B has only the probing members.
    await seedFixtures(harness.migrator, appClient, [acme]);
    // Statements are written only in the console realm; an issued one is what owners can read.
    await harness.migrator.query('BEGIN');
    await harness.migrator.query(
      `SELECT set_config('app.realm', 'platform', true), set_config('app.tenant_id', $1, true)`,
      [acme],
    );
    await harness.migrator.query(
      `INSERT INTO platform_statement (tenant_id, period, status, issued_at) VALUES ($1, '2001-02', 'ISSUED', now())`,
      [acme],
    );
    await harness.migrator.query('COMMIT');
    await asTenant(harness.migrator, acme, async () => {
      const withId = await harness.migrator.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id'`,
      );
      const hasId = new Set(withId.rows.map((row) => row.table_name));
      for (const table of await tenantOwnedTables(harness.migrator)) {
        if (!hasId.has(table)) continue;
        const { rows } = await harness.migrator.query<{ id: string }>(
          `SELECT id::text AS id FROM "${table}" WHERE tenant_id = $1 LIMIT 1`,
          [acme],
        );
        if (rows[0] !== undefined) {
          ids[table] = rows[0].id;
          markers.push(rows[0].id);
        }
      }
      const course = await harness.migrator.query<{ slug: string }>(`SELECT slug FROM course LIMIT 1`);
      ids['course:slug'] = course.rows[0]!.slug;
      const instructor = await harness.migrator.query<{ slug: string }>(
        `SELECT slug FROM instructor_profile LIMIT 1`,
      );
      ids['instructor_profile:slug'] = instructor.rows[0]?.slug ?? 'fixture-instructor';
      // A real, pending provider id is required: an invented id only exercises the unknown-event
      // acknowledgement and cannot detect cross-school completion of an existing upload.
      ids['asset:providerVideoId'] = `fake_${randomUUID()}`;
      await harness.migrator.query(
        `INSERT INTO asset (tenant_id, owner_membership_id, kind, purpose, provider, provider_video_id, original_name, mime, size_bytes)
         VALUES ($1, $2, 'VIDEO', 'LESSON_VIDEO', 'fake', $3, 'isolation-video.mp4', 'video/mp4', 2048)`,
        [acme, ids.tenant_membership, ids['asset:providerVideoId']],
      );
      // The SQL-policy fixture's opaque ciphertext cannot exercise HTTP signature verification.
      const sealed = harness.app
        .get<PaymentGateway>(PAYMENT_GATEWAY)
        .vault.sealAccount(
          acme,
          ids.payment_account!,
          { merchantId: 'isolation-fixture', apiKey: 'fixture-api-key', profile: 'FULL' },
          'isolation-webhook-secret',
        );
      await harness.migrator.query(
        'UPDATE payment_account SET credentials_enc = $2, webhook_secret_enc = $3, data_key_enc = $4 WHERE id = $1',
        [
          ids.payment_account,
          Buffer.from(sealed.credentialsEnc),
          Buffer.from(sealed.webhookSecretEnc),
          Buffer.from(sealed.dataKeyEnc),
        ],
      );
    });
    ids.tenant = acme;
    markers.push(acme, 'Acme Academy', 'Fixture course', 'Fixture quiz', 'fixture.pdf', 'Fixture tutor');

    const beta = harness.tenants.beta;
    for (const [actor, role] of [
      ['owner', 'TENANT_OWNER'],
      ['admin', 'TENANT_ADMIN'],
      ['instructor', 'INSTRUCTOR'],
      ['learner', null],
    ] as const) {
      const email = `${actor}-probe@beta.test`;
      await harness.member(SCHOOLS.beta, beta, email);
      if (role !== null) await harness.grantRole(beta, email, role);
      actors[actor] = { email, cookie: await harness.signIn(SCHOOLS.beta, email) };
    }
  }, 300_000);

  afterAll(async () => {
    await appClient?.end();
    await harness?.close();
  });

  it('coverage: every route’s path parameters are mapped (new routes must join this suite)', () => {
    const routes = listRoutes(harness.app);
    expect(routes.length).toBeGreaterThan(100);
    const unmapped = routes
      .filter((route) => route.split(' ')[1]!.startsWith('/api/v1'))
      .filter((route) => urlFor(route) === null);
    expect(unmapped).toEqual([]);
    expect(Object.keys(ISOLATION_PAYLOADS).filter((route) => !routes.includes(route))).toEqual([]);
    expect(Object.keys(actors).sort()).toEqual(['admin', 'anonymous', 'instructor', 'learner', 'owner']);
  });

  it('rejects foreign children under an owned local course without changing either school', async () => {
    const beta = harness.tenants.beta;
    const cookie = actors.instructor!.cookie;
    const local = await asTenant(harness.migrator, beta, async () => {
      const member = await harness.migrator.query<{ id: string }>(
        `SELECT m.id FROM tenant_membership m JOIN user_account u ON u.id=m.user_id WHERE u.email=$1`,
        [actors.instructor!.email],
      );
      const course = await harness.migrator.query<{ id: string }>(
        `INSERT INTO course (tenant_id, owner_membership_id, slug, title) VALUES ($1,$2,$3,'Local isolation course') RETURNING id`,
        [beta, member.rows[0]!.id, `mixed-${randomUUID()}`],
      );
      return course.rows[0]!.id;
    });
    // Positive control: this actor really can edit this parent; a blanket role denial would
    // otherwise conceal a missing nested-resource ownership check.
    const control = await harness.call('POST', `/api/v1/studio/courses/${local}/sections`, {
      host: SCHOOLS.beta,
      cookie,
      body: { title: 'Local control section' },
    });
    expect(control.statusCode, control.body).toBe(201);
    const before = await snapshot();
    const localBefore = await asTenant(
      harness.migrator,
      beta,
      async () =>
        (await harness.migrator.query('SELECT row_to_json(c) AS data FROM course c WHERE id=$1', [local]))
          .rows,
    );
    for (const [method, path, body] of [
      ['PATCH', `sections/${ids.section}`, { title: 'Foreign section overwrite' }],
      ['DELETE', `sections/${ids.section}`, undefined],
      ['PATCH', `lessons/${ids.lesson}`, { version: 1, title: 'Foreign lesson overwrite' }],
      ['DELETE', `lessons/${ids.lesson}`, undefined],
    ] as const) {
      const response = await harness.call(method, `/api/v1/studio/courses/${local}/${path}`, {
        host: SCHOOLS.beta,
        cookie,
        body,
      });
      expect(response.statusCode, `${method} ${path}: ${response.body}`).toBe(404);
    }
    expect(await snapshot()).toEqual(before);
    expect(
      await asTenant(
        harness.migrator,
        beta,
        async () =>
          (await harness.migrator.query('SELECT row_to_json(c) AS data FROM course c WHERE id=$1', [local]))
            .rows,
      ),
    ).toEqual(localBefore);
  });

  it('school B’s roles get nothing of school A from any endpoint, and change nothing of it', async () => {
    const before = await snapshot();
    // Leaving is a legitimate self-mutation: run it once, last, so the role's membership remains
    // valid for every earlier cross-school probe. Its poison body still names school A's ids.
    const routes = listRoutes(harness.app)
      .filter((route) => route.split(' ')[1]!.startsWith('/api/v1'))
      .sort((a, b) => Number(a === LEAVE_SCHOOL) - Number(b === LEAVE_SCHOOL));
    const leaks: string[] = [];
    const successes: string[] = [];
    const inconclusive: string[] = [];
    const identityMarkers = foreignResponseMarkers(markers);
    expect(identityMarkers.length).toBeGreaterThan(10);
    let calls = 0;
    for (const [actor, session] of Object.entries(actors)) {
      for (const route of routes) {
        const method = route.split(' ')[0] as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        const target = urlFor(route)!;
        const valid = isolationPayload(route, ids);
        const bodies =
          route === LEAVE_SCHOOL
            ? [poisonBody(`${actor}-isolation-probe@example.test`)]
            : method === 'GET' || method === 'DELETE'
              ? [undefined]
              : [
                  {},
                  poisonBody(`${actor}-isolation-probe@example.test`),
                  ...(valid === undefined ? [] : [valid]),
                ];
        for (const body of bodies) {
          const response = await harness.call(method, target.url, {
            host: SCHOOLS.beta,
            cookie: session.cookie,
            body,
          });
          calls += 1;
          const text = response.body;
          // An id the caller sent may be echoed back in a validation message; any other marker is a leak.
          const sent = `${target.url} ${JSON.stringify(body ?? {})}`;
          const found = identityMarkers.filter((marker) => !sent.includes(marker) && text.includes(marker));
          if (found.length > 0) leaks.push(`${actor} ${route} → ${response.statusCode}: ${found.join(', ')}`);
          if ((target.namesSchoolA || (valid !== undefined && body === valid)) && response.statusCode < 300) {
            successes.push(`${actor} ${route} → ${response.statusCode}`);
          }
          const problem =
            response.body !== '' && response.headers['content-type']?.includes('json')
              ? (response.json() as { code?: string; errors?: Array<{ field?: string; code?: string }> })
              : {};
          const code = problem.code;
          if (
            response.statusCode >= 500 ||
            response.statusCode === 429 ||
            (valid !== undefined &&
              body === valid &&
              code === 'VALIDATION_FAILED' &&
              !isReferenceValidationDenial(route, problem))
          ) {
            inconclusive.push(`${actor} ${route} → ${response.statusCode} ${code ?? ''}`);
          }
          if (ENDS_SESSION.test(route) && session.email !== undefined)
            session.cookie = await harness.signIn(SCHOOLS.beta, session.email);
        }
      }
    }
    expect(calls).toBeGreaterThan(routes.length * Object.keys(actors).length);
    expect(leaks).toEqual([]);
    expect(successes).toEqual([]);
    expect(inconclusive).toEqual([]);
    expect(await snapshot()).toEqual(before);
  }, 600_000);

  it('console routes do not exist on a school host, with or without a school session', async () => {
    const routes = listRoutes(harness.app).filter((route) => route.split(' ')[1]!.startsWith('/console'));
    expect(routes.length).toBeGreaterThan(30);
    const found: string[] = [];
    for (const route of routes) {
      const [method, path] = route.split(' ') as ['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string];
      const url = path.replace(/:[a-zA-Z]+/g, (param) => (param === ':id' ? acme : 'probe'));
      for (const [actor, cookie] of [
        ['anonymous', undefined],
        ['owner', actors.owner!.cookie],
      ] as const) {
        const response = await harness.call(method, url, {
          host: SCHOOLS.beta,
          cookie,
          ...(method !== 'GET' && method !== 'DELETE' && { body: {} }),
        });
        if (response.statusCode !== 404) found.push(`${actor} ${route} → ${response.statusCode}`);
      }
    }
    expect(found).toEqual([]);
  });
});
