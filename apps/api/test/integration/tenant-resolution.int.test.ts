import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PROBLEM_CONTENT_TYPE, problemSchema, tenantBootstrapSchema } from '@studyhub/contracts';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/main';
import { createLogger, loadApiEnv } from '../../src/modules/platform';
import { provisionTenant } from '../../src/modules/tenancy';
import { startTestDatabase, type TestDatabase } from '../setup/postgres-container';

const UNTRUSTED_ADDRESS = '203.0.113.9'; // TEST-NET-3, never a configured proxy

/**
 * Every school-scoped route and how the cross-tenant harness calls it. A new /api/v1 route fails
 * T-ISO-12 until it is added here with a cross-tenant check.
 */
const TENANT_ROUTES: ReadonlyArray<{ method: 'GET'; url: string }> = [
  { method: 'GET', url: '/api/v1/tenant' },
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
        { slug: 'beta', name: 'Beta College', kind: 'COLLEGE', hostname: 'beta.localhost', status: 'ACTIVE' },
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
    });
    const beta = await get('/api/v1/tenant', { host: 'beta.localhost' });
    expect(tenantBootstrapSchema.parse(beta.json()).id).toBe(tenants.beta);
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
    const printed = app.getHttpAdapter().getInstance().printRoutes({ commonPrefix: false });
    const routes = [...printed.matchAll(/(\/api\/v1[^\s(]*)\s*\(([^)]*)\)/g)].flatMap(([, path, methods]) =>
      (methods ?? '')
        .split(',')
        .map((method) => method.trim())
        .filter((method) => method !== 'HEAD' && method !== 'OPTIONS')
        .map((method) => `${method} ${path}`),
    );
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.sort()).toEqual(TENANT_ROUTES.map((route) => `${route.method} ${route.url}`).sort());
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
