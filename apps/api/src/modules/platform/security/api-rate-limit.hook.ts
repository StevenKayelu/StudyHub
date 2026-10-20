import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApiEnv } from '../config/env.schema';
import { currentContext } from '../context/request-context';
import { AppError } from '../errors/app-error';
import { sendProblem } from '../errors/problem.filter';
import { RateLimiter } from './rate-limiter';

type Limits = Pick<
  ApiEnv,
  'API_RATE_IP_PER_MINUTE' | 'API_RATE_TENANT_PER_MINUTE' | 'API_RATE_ACCOUNT_PER_MINUTE'
>;

/** Probes stay available even when a client or school exhausts its budget. */
function isProbe(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0];
  return (
    (request.method === 'GET' || request.method === 'HEAD') && (path === '/healthz' || path === '/readyz')
  );
}

function enforce(
  limiter: RateLimiter,
  key: string,
  limit: number,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    limiter.enforce([[key, { limit, windowMs: 60_000 }]]);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'RATE_LIMITED') throw error;
    void reply.header('Retry-After', String(error.extensions?.retryAfter));
    void reply.header('Cache-Control', 'no-store');
    return sendProblem(reply, request.id, error.code, {
      ...(error.detail !== undefined && { detail: error.detail }),
      ...(error.extensions !== undefined && { extensions: error.extensions }),
    });
  }
  return undefined;
}

/** Register before host resolution: invalid hosts and webhooks also consume a trusted client-IP budget. */
export function registerClientRateLimitHook(
  instance: FastifyInstance,
  limits: Limits,
  limiter = new RateLimiter(),
): void {
  instance.addHook('onRequest', async (request, reply) => {
    if (isProbe(request)) return;
    return enforce(limiter, `api:ip:${request.ip}`, limits.API_RATE_IP_PER_MINUTE, request, reply);
  });
}

/** Register after host resolution and before sessions; account checks run after authentication in preHandler. */
export function registerTenantRateLimitHook(
  instance: FastifyInstance,
  limits: Limits,
  limiter = new RateLimiter(),
): void {
  instance.addHook('onRequest', async (request, reply) => {
    const tenantId = currentContext()?.tenantId;
    if (tenantId === undefined || isProbe(request)) return;
    return enforce(limiter, `api:tenant:${tenantId}`, limits.API_RATE_TENANT_PER_MINUTE, request, reply);
  });
  instance.addHook('preHandler', async (request, reply) => {
    const context = currentContext();
    const account = context?.userId ?? context?.platformUserId;
    if (account === undefined || isProbe(request)) return;
    const scope = context?.tenantId ?? 'platform';
    return enforce(
      limiter,
      `api:account:${scope}:${account}`,
      limits.API_RATE_ACCOUNT_PER_MINUTE,
      request,
      reply,
    );
  });
}
