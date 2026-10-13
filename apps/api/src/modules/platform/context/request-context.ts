import { AsyncLocalStorage } from 'node:async_hooks';

import type { FastifyInstance } from 'fastify';

import { AppError } from '../errors/app-error';

/**
 * Per-request (or per-job) context. `tenantId` is set ONLY by the tenant-context hook from the
 * verified request host, or by the worker from a validated job envelope — never from client input.
 */
export interface RequestContext {
  requestId: string;
  tenantId?: string;
  /** The signed-in global account (tenant realm), set ONLY by the session hook from a valid session. */
  userId?: string;
  /** The signed-in staff member (console realm), set ONLY by the console session hook. */
  platformUserId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given context (used by the worker and CLI tools). */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The current tenant, or TENANT_CONTEXT_MISSING (a programming error, never a client error). */
export function requireTenantId(): string {
  const tenantId = storage.getStore()?.tenantId;
  if (tenantId === undefined) {
    throw new AppError('TENANT_CONTEXT_MISSING');
  }
  return tenantId;
}

/** Opens a context for every HTTP request; later hooks (tenant resolution) fill it in. */
export function registerRequestContextHook(instance: FastifyInstance): void {
  instance.addHook('onRequest', (request, _reply, done) => {
    storage.run({ requestId: request.id }, done);
  });
}
