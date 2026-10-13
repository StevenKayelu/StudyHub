import 'server-only';

import {
  type ConsoleMeResponse,
  consoleMeResponseSchema,
  type MeResponse,
  meResponseSchema,
} from '@studyhub/contracts';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

const apiBaseUrl = () => process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

/**
 * Server-side call to the API on behalf of the browser: the request's own host (so the API resolves
 * the same school) and its cookies (so the API sees the same session). Never cached.
 */
export async function apiGet(path: string): Promise<Response> {
  const incoming = await headers();
  return fetch(`${apiBaseUrl()}${path}`, {
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'x-forwarded-host': incoming.get('host') ?? '',
      ...(incoming.get('cookie') !== null && { cookie: incoming.get('cookie')! }),
    },
    signal: AbortSignal.timeout(5000),
  });
}

/** The signed-in person on this school host, or null. One API call per request. */
export const getMe = cache(async (): Promise<MeResponse | null> => {
  const response = await apiGet('/api/v1/me');
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`The API returned ${response.status} for /me.`);
  return meResponseSchema.parse(await response.json());
});

/** The signed-in, TOTP-verified staff member on the console host, or null. */
export const getConsoleMe = cache(async (): Promise<ConsoleMeResponse | null> => {
  const response = await apiGet('/console/me');
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`The API returned ${response.status} for /console/me.`);
  return consoleMeResponseSchema.parse(await response.json());
});

/** The path the browser asked for (set by src/proxy.ts), for "return to" after sign-in. */
export async function requestedPath(): Promise<string> {
  const path = (await headers()).get('x-studyhub-path') ?? '/';
  return path.startsWith('/') && !path.startsWith('//') ? path : '/';
}

/** Signed-in member of this school, or a redirect to sign-in that comes back here afterwards. */
export async function requireMember(): Promise<MeResponse> {
  const me = await getMe();
  if (me === null) redirect(`/sign-in?returnTo=${encodeURIComponent(await requestedPath())}`);
  return me;
}

/** Only same-site relative paths are followed after sign-in (no open redirects). */
export function safeReturnTo(value: string | string[] | undefined, fallback = '/learn'): string {
  const path = Array.isArray(value) ? value[0] : value;
  return typeof path === 'string' && /^\/(?![/\\])/.test(path) ? path : fallback;
}
