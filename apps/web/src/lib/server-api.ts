import {
  problemSchema,
  readyzResponseSchema,
  type TenantBootstrap,
  tenantBootstrapSchema,
} from '@studyhub/contracts';

export interface SystemStatus {
  api: 'ok' | 'unreachable';
  database: 'ok' | 'unavailable' | 'unknown';
  version: string | null;
  requestId: string | null;
}

const READINESS_FETCH_TIMEOUT_MS = 3000;

function apiBaseUrl(): string {
  return process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
}

/**
 * Server-side only: asks the API whether it is ready. Every response is validated against the shared
 * contracts; anything unexpected is reported as "unknown" rather than trusted.
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/readyz`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(READINESS_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { api: 'unreachable', database: 'unknown', version: null, requestId: null };
  }

  const requestId = response.headers.get('x-request-id');
  const body: unknown = await response.json().catch(() => null);

  const ready = readyzResponseSchema.safeParse(body);
  if (response.ok && ready.success) {
    return { api: 'ok', database: 'ok', version: ready.data.version, requestId };
  }

  const problem = problemSchema.safeParse(body);
  if (problem.success && problem.data.code === 'SERVICE_UNAVAILABLE') {
    return { api: 'ok', database: 'unavailable', version: null, requestId };
  }
  return { api: 'ok', database: 'unknown', version: null, requestId };
}

const SCHOOL_HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Server-side only: the school for a host (validated), asked from the API with that host in
 * X-Forwarded-Host. The host comes from the proxy rewrite, never from user-controlled input
 * (direct requests to /_tenant/* are rejected in src/proxy.ts). Returns null for unknown hosts.
 */
export async function getTenantBootstrap(host: string): Promise<TenantBootstrap | null> {
  if (!SCHOOL_HOST.test(host)) return null;
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}/api/v1/tenant`, {
      cache: 'no-store',
      headers: { accept: 'application/json', 'x-forwarded-host': host },
      signal: AbortSignal.timeout(READINESS_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error('The API is unreachable.');
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The API returned ${response.status} for the school bootstrap.`);
  return tenantBootstrapSchema.parse(await response.json());
}
