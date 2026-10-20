import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerSecurityHeadersHook } from './security-headers.hook';

describe('API security headers (M10 F-01)', () => {
  it.each([false, true])('covers success, errors and early denials (production=%s)', async (production) => {
    const app = Fastify();
    registerSecurityHeadersHook(app, production);
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/denied') return reply.code(429).send({ code: 'RATE_LIMITED' });
    });
    app.get('/ok', async () => ({ ok: true }));
    app.get('/failure', async () => {
      throw new Error('test failure');
    });
    app.post('/body', async (request) => request.body);
    app.get('/card', async (_request, reply) =>
      reply.type('text/html').send('<style>body{color:black}</style><form method="post"></form>'),
    );
    try {
      for (const [method, url, payload, status] of [
        ['GET', '/ok', undefined, 200],
        ['GET', '/missing', undefined, 404],
        ['GET', '/denied', undefined, 429],
        ['GET', '/card', undefined, 200],
        ['GET', '/failure', undefined, 500],
        ['POST', '/body', '{', 400],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          ...(payload !== undefined && { payload, headers: { 'content-type': 'application/json' } }),
        });
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
        expect(response.headers['permissions-policy']).toContain('camera=()');
        expect(response.headers['content-security-policy']).toContain("script-src 'none'");
        expect(response.headers['content-security-policy']).toContain("form-action 'self'");
        expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(response.headers['strict-transport-security']).toBe(
          production ? 'max-age=31536000' : undefined,
        );
        expect(response.statusCode).toBe(status);
      }
    } finally {
      await app.close();
    }
  });
});
