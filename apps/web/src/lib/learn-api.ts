import 'server-only';

import { redirect } from 'next/navigation';

import { apiGet, requestedPath } from './session';

/**
 * Server-side GET of a learning resource. Unlike fetchContent, a locked course or lesson (403
 * ENROLMENT_INACTIVE, F15 AC 2) is its own outcome, so the page can offer enrolment instead of content.
 */
export async function fetchLearning<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | 'locked' | null> {
  const response = await apiGet(path);
  if (response.status === 404) return null;
  if (response.status === 401) redirect(`/sign-in?returnTo=${encodeURIComponent(await requestedPath())}`);
  if (response.status === 403) return 'locked';
  if (!response.ok) throw new Error(`The API returned ${response.status} for ${path.split('?')[0]}.`);
  return schema.parse(await response.json());
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
