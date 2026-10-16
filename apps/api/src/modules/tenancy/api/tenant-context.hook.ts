import type { FastifyInstance } from 'fastify';

import { currentContext, isSchoolReadOnly, sendProblem } from '../../platform';
import type { TenantResolver } from '../application/tenant-resolver';

/** Every route under this prefix is school-scoped and requires a resolved tenant. */
export const TENANT_SCOPED_PREFIX = '/api/v1';

/** Provider webhooks arrive on a shared host; their handlers resolve the school themselves (04 §17.9). */
export const WEBHOOK_PREFIX = '/api/v1/webhooks/';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes a read-only school still accepts (BR-52): signing in (also by hand-off from another school),
 * signing out, and ending one's own sessions. Everything else that changes data is refused.
 */
const READ_ONLY_ALLOWED: readonly RegExp[] = [
  /^\/api\/v1\/auth\/(sign-in|sign-out|handoff)(\?|$)/,
  /^\/api\/v1\/me\/sessions(\/[^/?]+)?(\?|$)/,
  // Platform support may still help a read-only school (F44), and members may clear notifications.
  /^\/api\/v1\/support\/(handoff|end)(\?|$)/,
  /^\/api\/v1\/me\/notifications\/read(\?|$)/,
];

/** BR-53: during the 30-day offboarding window the owner can still export and cancel. */
const OFFBOARDING_ALLOWED: readonly RegExp[] = [
  /^\/api\/v1\/admin\/exports\/tenant(\?|$)/,
  /^\/api\/v1\/admin\/offboarding(\?|$)/,
];

function allowedWhileReadOnly(method: string, url: string, status: string | undefined): boolean {
  if (READS.has(method)) return true;
  if (status === 'OFFBOARDING' && OFFBOARDING_ALLOWED.some((pattern) => pattern.test(url))) return true;
  return READ_ONLY_ALLOWED.some((pattern) => pattern.test(url));
}

function isTenantScoped(url: string): boolean {
  if (url.startsWith(WEBHOOK_PREFIX)) return false;
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
 * - Suspended and offboarding schools are read-only (BR-52): writes get SCHOOL_READ_ONLY.
 * - A host retired by an address change gets TENANT_MOVED with the new primary host (BR-50).
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
    // BR-50: a retired address answers with the new one for 90 days; the web redirects permanently.
    if (tenant.redirect) {
      return sendProblem(reply, request.id, 'TENANT_MOVED', {
        extensions: { primaryHost: tenant.primaryHost },
      });
    }
    context.tenantId = tenant.tenantId;
    context.tenantStatus = tenant.status;
    request.log = request.log.child({ tenantId: tenant.tenantId });
    // BR-52/BR-53: a suspended or offboarding school is read-only; enrolled learners keep their content.
    if (isSchoolReadOnly() && !allowedWhileReadOnly(request.method, request.url, tenant.status)) {
      return sendProblem(reply, request.id, 'SCHOOL_READ_ONLY');
    }
    return undefined;
  });
}
