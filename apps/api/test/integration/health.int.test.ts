import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  healthzResponseSchema,
  PROBLEM_CONTENT_TYPE,
  problemSchema,
  readinessChecksSchema,
  readyzResponseSchema,
} from '@studyhub/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/main';
import { createLogger, loadApiEnv } from '../../src/modules/platform';
import { startTestDatabase, type TestDatabase } from '../setup/postgres-container';

describe('health and readiness probes', () => {
  let database: TestDatabase;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    database = await startTestDatabase({ migrate: true });
    const env = loadApiEnv({
      DATABASE_URL_APP: database.appUrl,
      LOG_LEVEL: 'silent',
      READINESS_TIMEOUT_MS: '1500',
      APP_VERSION: '9.9.9-test',
    });
    app = await createApp({ env, logger: createLogger({ level: 'silent' }) });
  });

  afterAll(async () => {
    await app?.close();
    await database?.stop().catch(() => undefined);
  });

  it('GET /healthz returns 200 matching the contract, uncached, with a request id', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toMatch(/^req_[0-9a-f-]{36}$/);
    const body = healthzResponseSchema.parse(response.json());
    expect(body.version).toBe('9.9.9-test');
  });

  it('GET /readyz returns 200 when the database is reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(readyzResponseSchema.parse(response.json())).toEqual({
      status: 'ok',
      version: '9.9.9-test',
      checks: { database: 'ok' },
    });
  });

  it('GET /readyz returns 503 SERVICE_UNAVAILABLE problem+json after the database stops', async () => {
    await database.stop();

    const started = Date.now();
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    const elapsedMs = Date.now() - started;

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const problem = problemSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(problem.requestId).toBe(response.headers['x-request-id']);
    expect(readinessChecksSchema.parse(problem.checks)).toEqual({ database: 'unavailable' });
    expect(elapsedMs).toBeLessThan(5000); // bounded by READINESS_TIMEOUT_MS, never hangs
  });

  it('GET /healthz stays 200 while the database is down (liveness ignores dependencies)', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });
});
