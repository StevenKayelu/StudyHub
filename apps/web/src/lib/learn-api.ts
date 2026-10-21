import 'server-only';

import { redirect } from 'next/navigation';

import { apiGet, requestedPath } from './session';

/**
 * Server-side GET of a learning resource. Unlike fetchContent, a locked course or lesson (403
 * ENROLMENT_INACTIVE, F15 AC 2) is its own outcome, so the page can offer enrolment instead of content.
 * Content beyond what a deposit opened (402 BALANCE_REQUIRED) or before the course's term opens (403
 * COURSE_NOT_OPEN) is locked here too; fetchLesson tells them apart.
 */
export async function fetchLearning<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | 'locked' | null> {
  const result = await fetchLesson(path, schema);
  return result === 'balance' || result === 'notOpen' ? 'locked' : result;
}

/**
 * As fetchLearning, but a lesson beyond the deposit is 'balance', so the player can offer the balance,
 * and one whose term hasn't opened is 'notOpen'.
 */
export async function fetchLesson<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | 'locked' | 'balance' | 'notOpen' | null> {
  const result = await fetchGated(path, schema);
  if (typeof result !== 'object' || result === null) return result;
  if ('balanceCourseId' in result) return 'balance';
  if ('notOpenCourseId' in result) return 'notOpen';
  return result;
}

/**
 * As fetchLearning, but content beyond the deposit, or before the course's term opens, names its course
 * (from the problem), so pages outside the player (a quiz, practice) can send the learner to the course.
 */
export async function fetchGated<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | 'locked' | { balanceCourseId: string } | { notOpenCourseId: string } | null> {
  const response = await apiGet(path);
  if (response.status === 404) return null;
  if (response.status === 401) redirect(`/sign-in?returnTo=${encodeURIComponent(await requestedPath())}`);
  if (response.status === 403) {
    const problem = (await response.json().catch(() => null)) as {
      code?: unknown;
      courseId?: unknown;
    } | null;
    if (problem?.code !== 'COURSE_NOT_OPEN') return 'locked';
    return { notOpenCourseId: typeof problem.courseId === 'string' ? problem.courseId : '' };
  }
  if (response.status === 402) {
    const problem = (await response.json().catch(() => null)) as { courseId?: unknown } | null;
    return { balanceCourseId: typeof problem?.courseId === 'string' ? problem.courseId : '' };
  }
  if (!response.ok) throw new Error(`The API returned ${response.status} for ${path.split('?')[0]}.`);
  return schema.parse(await response.json());
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
