import type { FastifyInstance } from 'fastify';

import { currentContext, sendProblem } from '../../platform';
import type { SessionService } from '../application/sessions';
import type { SupportSessionService } from '../application/support-sessions';
import { supportVerdict } from '../domain/support-policy';
import {
  clearCookie,
  currentActor,
  parseCookies,
  SESSION_COOKIE,
  setCookie,
  setCurrentActor,
  SUPPORT_COOKIE,
  TENANT_API_PREFIX,
} from './http';

/**
 * Resolves the tenant-realm session cookie into the request's actor. Runs after the tenant-context
 * hook, so the lookup happens inside the host's school only. An unknown, expired or other-school
 * cookie leaves the request anonymous and is cleared.
 *
 * M9 (F44): without a member session, a support cookie makes the request a support session. Its
 * scope and the BR-47 exclusions are enforced here, before any handler, and every request it makes
 * is written to both audit logs when the response is sent.
 */
export function registerSessionHook(
  instance: FastifyInstance,
  sessions: SessionService,
  support: SupportSessionService,
): void {
  instance.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(TENANT_API_PREFIX)) return undefined;
    if (currentContext()?.tenantId === undefined) return undefined; // tenant hook already answered
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.get(SESSION_COOKIE);
    if (token !== undefined && token !== '') {
      const actor = await sessions.authenticate(token);
      if (actor !== null) {
        setCurrentActor(actor);
        return undefined;
      }
      setCookie(reply, clearCookie(SESSION_COOKIE));
    }

    const supportToken = cookies.get(SUPPORT_COOKIE);
    if (supportToken === undefined || supportToken === '') return undefined;
    const actor = await support.authenticate(supportToken);
    if (actor === null || actor.support === undefined) {
      setCookie(reply, clearCookie(SUPPORT_COOKIE));
      return undefined;
    }
    setCurrentActor(actor);
    const verdict = supportVerdict(actor.support.scope, request.method, request.url);
    if (verdict === 'READ_ONLY') return sendProblem(reply, request.id, 'SUPPORT_READ_ONLY');
    if (verdict === 'EXCLUDED') return sendProblem(reply, request.id, 'SUPPORT_ACTION_EXCLUDED');
    return undefined;
  });

  instance.addHook('onResponse', async (request, reply) => {
    if (!request.url.startsWith(TENANT_API_PREFIX)) return;
    const actor = currentActor();
    if (actor?.support === undefined || request.url.startsWith('/api/v1/support/end')) return;
    try {
      await support.recordRequest(actor, {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
      });
    } catch (error) {
      request.log.error({ err: error }, 'Could not record a support-session request');
    }
  });
}
