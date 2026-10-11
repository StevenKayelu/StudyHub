import { problemSchema, readyzResponseSchema } from '@studyhub/contracts';

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
