import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  PROBLEM_CONTENT_TYPE,
  problemSchema,
  FEATURE_KEYS,
  tenantBootstrapSchema,
} from '@studyhub/contracts';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/main';
import { createLogger, loadApiEnv } from '../../src/modules/platform';
import { provisionTenant } from '../../src/modules/tenancy';
import { startTestDatabase, type TestDatabase } from '../setup/postgres-container';
import { listRoutes } from '../setup/routes';

const UNTRUSTED_ADDRESS = '203.0.113.9'; // TEST-NET-3, never a configured proxy

/**
 * Every school-scoped route and how the cross-tenant harness calls it. A new /api/v1 route fails
 * T-ISO-12 until it is added here with a cross-tenant check.
 */
const TENANT_ROUTES: ReadonlyArray<{ method: 'GET'; url: string }> = [
  { method: 'GET', url: '/api/v1/tenant' },
];

/**
 * Identity routes (M4). They act on the caller's own account, session or school and are covered by
 * identity.int.test.ts: cross-school replay (AC 2), "other school" rows of the authorization matrix
 * (AC 5) and the per-flow tests. A new route must be added here AND to those tests.
 */
const IDENTITY_ROUTES: readonly string[] = [
  'DELETE /api/v1/admin/invitations/:id',
  'DELETE /api/v1/admin/members/:membershipId',
  'DELETE /api/v1/me/sessions',
  'DELETE /api/v1/me/sessions/:id',
  'GET /api/v1/admin/team',
  'GET /api/v1/invitations/preview',
  'GET /api/v1/me',
  'GET /api/v1/me/schools',
  'GET /api/v1/me/sessions',
  'POST /api/v1/admin/invitations',
  'POST /api/v1/auth/handoff',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/sign-in',
  'POST /api/v1/auth/sign-out',
  'POST /api/v1/auth/verify-email',
  'POST /api/v1/auth/verify-email/resend',
  'POST /api/v1/invitations/accept',
  'POST /api/v1/me/password',
  'POST /api/v1/me/schools/:tenantId/handoff',
  'POST /api/v1/me/schools/current/join',
  'POST /api/v1/me/schools/current/leave',
  'PUT /api/v1/admin/members/:membershipId/roles',
];

/**
 * Catalogue, authoring and media routes (M5), learning routes (M6) and assessment routes (M7). Covered by catalogue.int.test.ts
 * (school isolation of the catalogue, slugs, uploads, webhooks, AC 2–5), learning.int.test.ts (M6 AC 1–3), assessment.int.test.ts
 * (M7 AC 1–6) and by the M5–M7 rows of the authorization matrix.
 * Webhooks are not school-scoped by host: they resolve the school through resolve_video_asset().
 */
const CONTENT_ROUTES: readonly string[] = [
  'DELETE /api/v1/studio/courses/:id/lessons/:lessonId',
  'DELETE /api/v1/studio/courses/:id/sections/:sectionId',
  'DELETE /api/v1/studio/questions/:id',
  'DELETE /api/v1/studio/quizzes/:id',
  'GET /api/v1/admin/categories',
  'GET /api/v1/admin/course-reviews',
  'GET /api/v1/admin/courses',
  'GET /api/v1/admin/courses/:id/enrollments',
  'GET /api/v1/admin/instructor-applications',
  'GET /api/v1/assets/:id',
  'GET /api/v1/assets/:id/download',
  'GET /api/v1/categories',
  'GET /api/v1/courses',
  'GET /api/v1/courses/:slug',
  'GET /api/v1/instructors/:slug',
  'GET /api/v1/learn/attempts/:id',
  'GET /api/v1/learn/attempts/:id/result',
  'GET /api/v1/learn/courses/:id',
  'GET /api/v1/learn/courses/:id/practice',
  'GET /api/v1/learn/lessons/:id',
  'GET /api/v1/learn/lessons/:id/files/:assetId/url',
  'GET /api/v1/learn/lessons/:id/playback',
  'GET /api/v1/learn/quizzes/:id',
  'GET /api/v1/learn/quizzes/:id/attempts',
  'GET /api/v1/me/assessments',
  'GET /api/v1/me/enrollments',
  'GET /api/v1/me/instructor',
  'GET /api/v1/studio/attempts/:id',
  'GET /api/v1/studio/courses',
  'GET /api/v1/studio/courses/:id',
  'GET /api/v1/studio/courses/:id/attempts',
  'GET /api/v1/studio/courses/:id/grading-queue',
  'GET /api/v1/studio/courses/:id/learners',
  'GET /api/v1/studio/courses/:id/lessons/:lessonId',
  'GET /api/v1/studio/courses/:id/outline',
  'GET /api/v1/studio/courses/:id/publish-checklist',
  'GET /api/v1/studio/courses/:id/questions',
  'GET /api/v1/studio/courses/:id/quizzes',
  'GET /api/v1/studio/questions/:id',
  'GET /api/v1/studio/quizzes/:id',
  'GET /api/v1/studio/quizzes/:id/analytics',
  'PATCH /api/v1/admin/categories/:id',
  'PATCH /api/v1/admin/subjects/:id',
  'PATCH /api/v1/studio/courses/:id',
  'PATCH /api/v1/studio/courses/:id/lessons/:lessonId',
  'PATCH /api/v1/studio/courses/:id/sections/:sectionId',
  'PATCH /api/v1/studio/questions/:id',
  'PATCH /api/v1/studio/quizzes/:id',
  'POST /api/v1/admin/categories',
  'POST /api/v1/admin/courses/:id/enrollments',
  'POST /api/v1/admin/courses/:id/review',
  'POST /api/v1/admin/courses/:id/unpublish',
  'POST /api/v1/admin/enrollments/:id/revoke',
  'POST /api/v1/admin/instructors/:membershipId/decision',
  'POST /api/v1/admin/subjects',
  'POST /api/v1/courses/:slug/enrol',
  'POST /api/v1/learn/attempts/:id/submit',
  'POST /api/v1/learn/courses/:id/practice',
  'POST /api/v1/learn/practice/:attemptId/finish',
  'POST /api/v1/learn/quizzes/:id/attempts',
  'POST /api/v1/me/instructor/submit',
  'POST /api/v1/studio/courses',
  'POST /api/v1/studio/courses/:id/archive',
  'POST /api/v1/studio/courses/:id/lessons',
  'POST /api/v1/studio/courses/:id/publish',
  'POST /api/v1/studio/courses/:id/questions',
  'POST /api/v1/studio/courses/:id/quizzes',
  'POST /api/v1/studio/courses/:id/sections',
  'POST /api/v1/studio/courses/:id/submit',
  'POST /api/v1/studio/courses/:id/unpublish',
  'POST /api/v1/studio/questions/:id/duplicate',
  'POST /api/v1/uploads',
  'POST /api/v1/uploads/:id/complete',
  'POST /api/v1/videos',
  'POST /api/v1/webhooks/video/:provider',
  'PUT /api/v1/dev/fake-video/:providerVideoId',
  'PUT /api/v1/learn/attempts/:id/answers/:itemId',
  'PUT /api/v1/learn/lessons/:id/progress',
  'PUT /api/v1/learn/practice/:attemptId/answers/:itemId',
  'PUT /api/v1/me/instructor',
  'PUT /api/v1/studio/attempts/:id/items/:itemId/grade',
  'PUT /api/v1/studio/courses/:id/outline/order',
  'PUT /api/v1/studio/quizzes/:id/items',
];

/**
 * Commerce routes (M8). Covered by commerce.int.test.ts (07 M8 AC 1-8: per-account webhooks verified with
 * the account's own secret, cross-account signature confusion, failure isolation, write-only credentials)
 * and by the M8 rows of the authorization matrix. Payment webhooks are not school-scoped by host: they
 * resolve the school through resolve_payment_account(). The dev routes answer only with the fake provider.
 */
const COMMERCE_ROUTES: readonly string[] = [
  'DELETE /api/v1/admin/payment-accounts/:id',
  'DELETE /api/v1/me/payout-methods/:id',
  'GET /api/v1/admin/earnings',
  'GET /api/v1/admin/earnings/:membershipId',
  'GET /api/v1/admin/orders',
  'GET /api/v1/admin/orders/:id',
  'GET /api/v1/admin/payment-accounts',
  'GET /api/v1/admin/payment-accounts/:id/capabilities',
  'GET /api/v1/admin/payment-exceptions',
  'GET /api/v1/admin/payment-providers',
  'GET /api/v1/admin/payouts',
  'GET /api/v1/admin/settings',
  'GET /api/v1/dev/fake-pay/:transactionId',
  'GET /api/v1/me/orders',
  'GET /api/v1/me/orders/:id/receipt',
  'GET /api/v1/me/payout-methods',
  'GET /api/v1/orders/:id',
  'GET /api/v1/payments/return',
  'GET /api/v1/studio/earnings',
  'GET /api/v1/studio/earnings.csv',
  'PATCH /api/v1/admin/settings',
  'POST /api/v1/admin/orders/:id/refunds',
  'POST /api/v1/admin/payment-accounts',
  'POST /api/v1/admin/payment-accounts/:id/activate',
  'POST /api/v1/admin/payment-accounts/:id/test',
  'POST /api/v1/admin/payments/:id/recheck',
  'POST /api/v1/admin/payments/:id/resolve',
  'POST /api/v1/admin/payouts',
  'POST /api/v1/dev/fake-pay/:transactionId/:decision',
  'POST /api/v1/dev/fake-pay/phone/:paymentId/:decision',
  'POST /api/v1/me/payout-methods',
  'POST /api/v1/me/payout-methods/:id/default',
  'POST /api/v1/orders',
  'POST /api/v1/orders/:id/cancel',
  'POST /api/v1/orders/:id/payments',
  'POST /api/v1/orders/:id/refresh',
  'POST /api/v1/webhooks/payments/:provider/:accountId',
  'PUT /api/v1/admin/payment-accounts/:id/credentials',
];

describe('tenant resolution over HTTP (T-ISO-10..13)', () => {
  let database: TestDatabase;
  let migrator: Client;
  let app: NestFastifyApplication;
  const tenants: Record<'acme' | 'beta' | 'pending', string> = { acme: '', beta: '', pending: '' };

  beforeAll(async () => {
    database = await startTestDatabase({ migrate: true });
    migrator = await database.connect(database.migratorUrl);
    for (const [key, input] of [
      [
        'acme',
        { slug: 'acme', name: 'Acme Academy', kind: 'SCHOOL', hostname: 'acme.localhost', status: 'ACTIVE' },
      ],
      [
        'beta',
        {
          slug: 'beta',
          name: 'Beta College',
          kind: 'COLLEGE',
          hostname: 'beta.localhost',
          status: 'ACTIVE',
          branding: {
            accentHex: '#0B7285',
            fontPreset: 'HUMANIST',
            terminology: { instructor: { en: 'Lecturer' } },
          },
        },
      ],
      [
        'pending',
        {
          slug: 'gamma',
          name: 'Gamma Tutors',
          kind: 'TUTORING_BUSINESS',
          hostname: 'gamma.localhost',
          status: 'PROVISIONING',
        },
      ],
    ] as const) {
      const result = await provisionTenant(migrator, input);
      if (result.outcome !== 'created') throw new Error('provisioning failed');
      tenants[key] = result.tenantId;
    }
    const env = loadApiEnv({ DATABASE_URL_APP: database.appUrl, LOG_LEVEL: 'silent' });
    app = await createApp({ env, logger: createLogger({ level: 'silent' }) });
  });

  afterAll(async () => {
    await app?.close();
    await migrator?.end();
    await database?.stop();
  });

  const get = (url: string, headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'GET', url, headers, remoteAddress });

  it('resolves each school from its own host', async () => {
    const acme = await get('/api/v1/tenant', { host: 'acme.localhost' });
    expect(acme.statusCode).toBe(200);
    expect(tenantBootstrapSchema.parse(acme.json())).toEqual({
      id: tenants.acme,
      slug: 'acme',
      name: 'Acme Academy',
      status: 'ACTIVE',
      // Provisioning publishes the Copperline defaults and the default language settings.
      branding: {
        version: 1,
        displayName: 'Acme Academy',
        accentHex: null,
        fontPreset: 'COPPERLINE',
        showPoweredBy: true,
        terminology: {},
      },
      locales: { defaultLocale: 'en', enabledLocales: ['en'], timeZone: 'Africa/Lusaka' },
      // Every feature is on until plans arrive (M9) or the school switches one off (F40, BR-48).
      // Every feature is on by default except instructor revenue share (M8 PROPOSED 4).
      features: Object.fromEntries(FEATURE_KEYS.map((key) => [key, key !== 'instructorRevenueShare'])),
    });
    const beta = tenantBootstrapSchema.parse(
      (await get('/api/v1/tenant', { host: 'beta.localhost' })).json(),
    );
    expect(beta.id).toBe(tenants.beta);
    // Each school gets only its own branding (stored lowercase).
    expect(beta.branding).toMatchObject({
      accentHex: '#0b7285',
      fontPreset: 'HUMANIST',
      terminology: { instructor: { en: 'Lecturer' } },
    });
  });

  it('T-ISO-10: normalises case, port and trailing dot', async () => {
    for (const host of ['ACME.localhost', 'acme.localhost:3000', 'acme.localhost.']) {
      const response = await get('/api/v1/tenant', { host });
      expect(response.statusCode, host).toBe(200);
      expect(response.json().id, host).toBe(tenants.acme);
    }
  });

  it('T-ISO-10: unknown or malformed hosts get a generic TENANT_NOT_FOUND naming no school', async () => {
    for (const host of ['nope.localhost', 'localhost', '127.0.0.1', 'acme_bad.localhost']) {
      const response = await get('/api/v1/tenant', { host });
      expect(response.statusCode, host).toBe(404);
      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      const problem = problemSchema.parse(response.json());
      expect(problem.code).toBe('TENANT_NOT_FOUND');
      expect(response.body).not.toMatch(/acme|beta|gamma/i);
    }
  });

  it('reports a provisioning school with its status (lifecycle handled by later milestones)', async () => {
    const response = await get('/api/v1/tenant', { host: 'gamma.localhost' });
    expect(response.json()).toMatchObject({ id: tenants.pending, status: 'PROVISIONING' });
  });

  it('T-ISO-11: X-Forwarded-Host is honoured only from a trusted proxy address', async () => {
    const trusted = await get('/api/v1/tenant', {
      host: 'acme.localhost',
      'x-forwarded-host': 'beta.localhost',
    });
    expect(trusted.json().id).toBe(tenants.beta);

    const untrusted = await get(
      '/api/v1/tenant',
      { host: 'acme.localhost', 'x-forwarded-host': 'beta.localhost' },
      UNTRUSTED_ADDRESS,
    );
    expect(untrusted.statusCode).toBe(200);
    expect(untrusted.json().id).toBe(tenants.acme);
  });

  it('T-ISO-13: client-supplied tenant ids in query or headers are ignored', async () => {
    const response = await get(`/api/v1/tenant?tenantId=${tenants.beta}&tenant_id=${tenants.beta}`, {
      host: 'acme.localhost',
      'x-tenant-id': tenants.beta,
      'x-studyhub-tenant': tenants.beta,
    });
    expect(response.json().id).toBe(tenants.acme);
  });

  it('T-ISO-12: every /api/v1 route is in the cross-tenant harness', () => {
    const routes = listRoutes(app).filter((route) => route.split(' ')[1]!.startsWith('/api/v1'));
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toEqual(
      [
        ...TENANT_ROUTES.map((route) => `${route.method} ${route.url}`),
        ...IDENTITY_ROUTES,
        ...CONTENT_ROUTES,
        ...COMMERCE_ROUTES,
      ].sort(),
    );
  });

  it('T-ISO-12: no school-scoped response on one host contains another school’s data', async () => {
    const markers = { acme: [tenants.acme, 'Acme Academy'], beta: [tenants.beta, 'Beta College'] };
    for (const route of TENANT_ROUTES) {
      const onBeta = await app.inject({
        method: route.method,
        url: route.url,
        headers: { host: 'beta.localhost' },
      });
      for (const marker of markers.acme) expect(onBeta.body, `${route.url} on beta`).not.toContain(marker);
      const onAcme = await app.inject({
        method: route.method,
        url: route.url,
        headers: { host: 'acme.localhost' },
      });
      for (const marker of markers.beta) expect(onAcme.body, `${route.url} on acme`).not.toContain(marker);
    }
  });

  it('platform probes stay available on any host (they are not school-scoped)', async () => {
    expect((await get('/healthz', { host: 'nope.localhost' })).statusCode).toBe(200);
  });
});
