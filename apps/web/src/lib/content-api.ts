import 'server-only';

import { redirect } from 'next/navigation';

import { apiGet, requestedPath } from './session';

/**
 * Server-side GET of a school API resource, validated against its contract. 404 gives null (the page
 * renders not-found); 401 on a members-only catalogue sends the visitor to sign in and back.
 */
export async function fetchContent<T>(path: string, schema: { parse(value: unknown): T }): Promise<T | null> {
  const response = await apiGet(path);
  if (response.status === 404) return null;
  if (response.status === 401) redirect(`/sign-in?returnTo=${encodeURIComponent(await requestedPath())}`);
  if (!response.ok) throw new Error(`The API returned ${response.status} for ${path.split('?')[0]}.`);
  return schema.parse(await response.json());
}
