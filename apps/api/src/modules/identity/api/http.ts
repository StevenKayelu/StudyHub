import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { currentContext, type RequestContext, sendProblem } from '../../platform';
import type { TenantActor } from '../domain/policy';

/** Tenant-realm session cookie: host-only (`__Host-`), so one per school host (04 §8, BR-44). */
export const SESSION_COOKIE = '__Host-sh_session';
/** Console-realm session cookie, set only on the console host (04 §17.5). */
export const CONSOLE_COOKIE = '__Host-sh_console';
/** A platform staff member's support session on ONE school host (F44, M9). */
export const SUPPORT_COOKIE = '__Host-sh_support';

/** Tenant routes and console routes: the two realms' API prefixes. */
export const TENANT_API_PREFIX = '/api/v1/';
export const CONSOLE_API_PREFIX = '/console/';

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/**
 * `Secure; HttpOnly; SameSite=Lax; Path=/` with no Domain: required by the `__Host-` prefix, and
 * what keeps a school's cookie on that school's host only. Browsers accept Secure cookies on
 * http://*.localhost, so local development needs no TLS.
 */
export function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function setCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader('set-cookie');
  const list = Array.isArray(existing) ? existing : existing === undefined ? [] : [String(existing)];
  void reply.header('set-cookie', [...list, cookie]);
}

/** The client address as seen through trusted proxies only (Fastify trustProxy). */
export function clientIp(request: FastifyRequest): string | null {
  const ip = request.ip;
  return typeof ip === 'string' && /^[0-9a-fA-F.:]+$/.test(ip) ? ip : null;
}

export function userAgent(request: FastifyRequest): string | null {
  const value = request.headers['user-agent'];
  return typeof value === 'string' ? value.slice(0, 300) : null;
}

/** The signed-in tenant actor of the current request (set by the session hook). */
const actors = new WeakMap<RequestContext, TenantActor>();

export function setCurrentActor(actor: TenantActor): void {
  const context = currentContext();
  if (context === undefined) throw new Error('No request context');
  context.userId = actor.userId;
  actors.set(context, actor);
}

export function currentActor(): TenantActor | null {
  const context = currentContext();
  return context === undefined ? null : (actors.get(context) ?? null);
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence (04 §8): SameSite=Lax cookies plus, on every state-changing API request, an Origin that
 * matches the request's own host (or `Sec-Fetch-Site: same-origin` when a browser omits Origin).
 * Cross-site form posts and scripts on other origins are refused before any handler runs.
 */
export function registerOriginCheckHook(instance: FastifyInstance): void {
  instance.addHook('onRequest', async (request, reply) => {
    if (!UNSAFE.has(request.method)) return undefined;
    if (!request.url.startsWith(TENANT_API_PREFIX) && !request.url.startsWith(CONSOLE_API_PREFIX))
      return undefined;
    // Provider webhooks are server-to-server and authenticated by their signature instead.
    if (request.url.startsWith('/api/v1/webhooks/')) return undefined;
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== 'null') {
      let originHost: string | null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = null;
      }
      if (originHost !== null && originHost === request.host.toLowerCase()) return undefined;
    } else if (request.headers['sec-fetch-site'] === 'same-origin') {
      return undefined;
    }
    return sendProblem(reply, request.id, 'ORIGIN_REJECTED');
  });
}
