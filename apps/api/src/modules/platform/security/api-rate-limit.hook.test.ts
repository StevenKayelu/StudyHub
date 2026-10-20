import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { currentContext, registerRequestContextHook } from '../context/request-context';
import { registerRequestIdHook } from '../logging/request-id.hook';
import { registerClientRateLimitHook, registerTenantRateLimitHook } from './api-rate-limit.hook';
import { RateLimiter } from './rate-limiter';

const limits = { API_RATE_IP_PER_MINUTE: 2, API_RATE_TENANT_PER_MINUTE: 3, API_RATE_ACCOUNT_PER_MINUTE: 2 };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(overrides = {}, trustProxy: boolean | string[] = false) {
  let now = 0;
  const app = Fastify({ trustProxy });
  apps.push(app);
  registerRequestIdHook(app);
  registerRequestContextHook(app);
  const config = { ...limits, ...overrides };
  registerClientRateLimitHook(app, config, new RateLimiter(() => now));
  // Test-only resolver: production gets the id from TenantResolver, never a client-provided id.
  app.addHook('onRequest', async (request) => {
    const context = currentContext()!;
    if (request.host === 'a.test') context.tenantId = 'school-a';
    if (request.host === 'alias-a.test') context.tenantId = 'school-a';
    if (request.host === 'b.test') context.tenantId = 'school-b';
  });
  registerTenantRateLimitHook(app, config, new RateLimiter(() => now));
  app.addHook('onRequest', async (request) => {
    if (request.headers.cookie === 'member=alice') currentContext()!.userId = 'alice';
    if (request.headers.cookie === 'staff=operator') currentContext()!.platformUserId = 'operator';
  });
  for (const path of ['/resource', '/healthz', '/readyz', '/api/v1/webhooks/payment']) {
    app.get(path, async () => ({ ok: true }));
  }
  return {
    app,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('API request budgets (M10 F-02)', () => {
  it('returns problem+json, a request id and Retry-After; resets at the window boundary', async () => {
    const { app, advance } = setup();
    for (let i = 0; i < 2; i += 1) expect((await app.inject('/resource')).statusCode).toBe(200);
    const denied = await app.inject('/resource');
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['content-type']).toContain('application/problem+json');
    expect(denied.headers['retry-after']).toBe('60');
    expect(denied.headers['cache-control']).toBe('no-store');
    expect(denied.json()).toMatchObject({ code: 'RATE_LIMITED', requestId: denied.headers['x-request-id'] });
    advance(59_001);
    expect((await app.inject('/resource')).headers['retry-after']).toBe('1');
    advance(999);
    expect((await app.inject('/resource')).statusCode).toBe(200);
  });

  it('does not trust spoofed forwarded IPs from an untrusted peer', async () => {
    const { app } = setup();
    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({ url: '/resource', headers: { 'x-forwarded-for': `192.0.2.${i}` } });
      expect(response.statusCode).toBe(i < 2 ? 200 : 429);
    }
  });

  it('uses forwarded client IPs only through the configured trusted proxy', async () => {
    const { app } = setup({}, ['127.0.0.1']);
    for (let i = 0; i < 3; i += 1) {
      expect(
        (
          await app.inject({
            url: '/resource',
            remoteAddress: '127.0.0.1',
            headers: { 'x-forwarded-for': `192.0.2.${i}` },
          })
        ).statusCode,
      ).toBe(200);
    }
  });

  it('shares a school budget across IPs and host aliases, without spending another school budget', async () => {
    const { app } = setup({ API_RATE_IP_PER_MINUTE: 100 });
    for (let i = 0; i < 4; i += 1) {
      const response = await app.inject({
        url: '/resource',
        remoteAddress: `192.0.2.${i}`,
        headers: { host: i % 2 ? 'alias-a.test' : 'a.test' },
      });
      expect(response.statusCode).toBe(i < 3 ? 200 : 429);
    }
    expect((await app.inject({ url: '/resource', headers: { host: 'b.test' } })).statusCode).toBe(200);
  });

  it.each(['member=alice', 'staff=operator'])(
    'limits authenticated accounts across IPs (%s)',
    async (cookie) => {
      const { app } = setup({ API_RATE_IP_PER_MINUTE: 100, API_RATE_TENANT_PER_MINUTE: 100 });
      for (let i = 0; i < 3; i += 1) {
        const response = await app.inject({
          url: '/resource',
          remoteAddress: `192.0.2.${i}`,
          headers: { host: cookie.startsWith('staff') ? 'console.test' : 'a.test', cookie },
        });
        expect(response.statusCode).toBe(i < 2 ? 200 : 429);
      }
      expect(
        (
          await app.inject({
            url: '/resource',
            headers: { host: cookie.startsWith('staff') ? 'console-alias.test' : 'b.test', cookie },
          })
        ).statusCode,
      ).toBe(cookie.startsWith('staff') ? 429 : 200);
    },
  );

  it('limits webhooks and unknown routes by IP while leaving exact health probes available', async () => {
    const { app } = setup();
    await app.inject('/api/v1/webhooks/payment');
    await app.inject('/unknown');
    expect((await app.inject('/api/v1/webhooks/payment')).statusCode).toBe(429);
    for (const path of ['/healthz?check=1', '/readyz']) expect((await app.inject(path)).statusCode).toBe(200);
    expect((await app.inject('/healthz/other')).statusCode).toBe(429);
  });

  it('admits new keys under churn by evicting only the oldest counter', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now, 2);
    const rule = { limit: 1, windowMs: 1000 };
    expect(limiter.hit('a', rule)).toBeNull();
    expect(limiter.hit('b', rule)).toBeNull();
    // Full: a new client is still served, and only the oldest counter ('a') is dropped.
    expect(limiter.hit('new-key', rule)).toBeNull();
    expect(limiter.hit('b', rule)).toBe(1);
    expect(limiter.hit('new-key', rule)).toBe(1);
    now = 1000;
    expect(limiter.hit('new-key', rule)).toBeNull();
  });

  it('prefers expired counters over live ones when full', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now, 2);
    expect(limiter.hit('short', { limit: 1, windowMs: 100 })).toBeNull();
    expect(limiter.hit('long', { limit: 1, windowMs: 10_000 })).toBeNull();
    now = 2000;
    expect(limiter.hit('new-key', { limit: 1, windowMs: 1000 })).toBeNull();
    expect(limiter.hit('long', { limit: 1, windowMs: 10_000 })).toBe(8);
  });
});
