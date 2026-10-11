import type { FastifyInstance } from 'fastify';

import { currentContext, sendProblem } from '../../platform';
import type { TenantResolver } from '../application/tenant-resolver';

/** Every route under this prefix is school-scoped and requires a resolved tenant. */
export const TENANT_SCOPED_PREFIX = '/api/v1';

function isTenantScoped(url: string): boolean {
  return (
    url === TENANT_SCOPED_PREFIX ||
    url.startsWith(`${TENANT_SCOPED_PREFIX}/`) ||
    url.startsWith(`${TENANT_SCOPED_PREFIX}?`)
  );
}

/**
 * Resolves the school from the request host and puts it in the request context (design §3.6).
 *
 * - The host comes from Fastify's `request.host`, which honours X-Forwarded-Host ONLY from
 *   TRUSTED_PROXIES (threat T3).
 * - Nothing else can set the tenant: ids in headers, query strings or bodies are ignored (T2).
 * - Unknown, unverified or deleted hosts get a generic TENANT_NOT_FOUND that names no school (BR-60).
 */
export function registerTenantContextHook(instance: FastifyInstance, resolver: TenantResolver): void {
  instance.addHook('onRequest', async (request, reply) => {
    if (!isTenantScoped(request.url)) return;

    const context = currentContext();
    if (context === undefined) {
      return sendProblem(reply, request.id, 'TENANT_CONTEXT_MISSING');
    }
    const tenant = await resolver.resolve(request.host);
    if (tenant === null) {
      return sendProblem(reply, request.id, 'TENANT_NOT_FOUND');
    }
    context.tenantId = tenant.tenantId;
    request.log = request.log.child({ tenantId: tenant.tenantId });
    return undefined;
  });
}
