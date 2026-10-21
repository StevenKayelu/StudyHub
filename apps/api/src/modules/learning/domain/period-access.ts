/**
 * Whether a course's content is open (docs/design/course-periods.md §2). First match wins: the
 * administrator's override on the course, then no period (open), then the period's manual switch,
 * then its start date. The end date never locks anything (decision 3).
 */
export type PeriodMode = 'AUTO' | 'OPEN' | 'LOCKED';
export type AccessOverride = 'OPEN' | 'LOCKED';

export interface PeriodForLock {
  name: string;
  startsAt: Date;
  mode: PeriodMode;
}

/** Why a course is closed, and when it opens (null: when an administrator opens it). */
export interface CourseLock {
  periodName: string | null;
  opensAt: Date | null;
}

export function courseLock(
  period: PeriodForLock | null,
  override: AccessOverride | null,
  now: Date,
): CourseLock | null {
  const periodName = period?.name ?? null;
  if (override === 'OPEN') return null;
  if (override === 'LOCKED') return { periodName, opensAt: null };
  if (period === null || period.mode === 'OPEN') return null;
  if (period.mode === 'LOCKED') return { periodName, opensAt: null };
  return now >= period.startsAt ? null : { periodName, opensAt: period.startsAt };
}
