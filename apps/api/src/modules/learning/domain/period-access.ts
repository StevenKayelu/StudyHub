/**
 * Whether a topic assigned to a period is open. The period's manual switch wins over its start
 * date; its end date never locks anything.
 */
export type PeriodMode = 'AUTO' | 'OPEN' | 'LOCKED';

export interface PeriodForLock {
  name: string;
  startsAt: Date;
  mode: PeriodMode;
}

/** Why a topic is closed, and when it opens (null: when an administrator opens its period). */
export interface PeriodLock {
  periodName: string;
  opensAt: Date | null;
}

export function periodLock(period: PeriodForLock | null, now: Date): PeriodLock | null {
  if (period === null) return null;
  if (period.mode === 'OPEN') return null;
  if (period.mode === 'LOCKED') return { periodName: period.name, opensAt: null };
  return now >= period.startsAt ? null : { periodName: period.name, opensAt: period.startsAt };
}
