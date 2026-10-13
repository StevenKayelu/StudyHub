import type { FastifyInstance } from 'fastify';

import { currentContext } from '../../platform';
import type { SessionService } from '../application/sessions';
import {
  clearCookie,
  parseCookies,
  SESSION_COOKIE,
  setCookie,
  setCurrentActor,
  TENANT_API_PREFIX,
} from './http';

/**
 * Resolves the tenant-realm session cookie into the request's actor. Runs after the tenant-context
 * hook, so the lookup happens inside the host's school only. An unknown, expired or other-school
 * cookie leaves the request anonymous and is cleared.
 */
export function registerSessionHook(instance: FastifyInstance, sessions: SessionService): void {
  instance.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(TENANT_API_PREFIX)) return;
    if (currentContext()?.tenantId === undefined) return; // tenant hook already answered
    const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    if (token === undefined || token === '') return;
    const actor = await sessions.authenticate(token);
    if (actor === null) {
      setCookie(reply, clearCookie(SESSION_COOKIE));
      return;
    }
    setCurrentActor(actor);
  });
}
