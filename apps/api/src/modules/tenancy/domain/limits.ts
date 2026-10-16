import { DEFAULT_PLAN_LIMITS, type PlanLimits, planLimitsSchema } from '@studyhub/contracts';

/** Plan limits that are enforced at the action that would exceed them (BR-49). */
export type LimitKind = 'activeLearners' | 'instructors' | 'admins' | 'storage';
export type MeterState = 'OK' | 'WARN' | 'FULL';

/** Owners are warned at 80 % and at 100 % (F40 AC 3). */
export const WARN_AT = 0.8;

const GB = 1024 ** 3;

/** Stored plan limits, each field validated on its own; anything missing or invalid takes the default. */
export function limitsFrom(stored: unknown): PlanLimits {
  const values: Record<string, unknown> = {};
  if (stored !== null && typeof stored === 'object') {
    for (const [key, value] of Object.entries(stored)) {
      const field = (
        planLimitsSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>
      )[key];
      if (field?.safeParse(value).success === true) values[key] = value;
    }
  }
  return { ...DEFAULT_PLAN_LIMITS, ...values } as PlanLimits;
}

/** The numeric limit of a kind (bytes for storage); null when unlimited. */
export function limitOf(limits: PlanLimits, kind: LimitKind): number | null {
  switch (kind) {
    case 'activeLearners':
      return limits.maxActiveLearners;
    case 'instructors':
      return limits.maxInstructors;
    case 'admins':
      return limits.maxAdmins;
    case 'storage':
      return Math.floor(limits.storageGb * GB);
  }
}

/** Whether `adding` more would exceed the limit. */
export function wouldExceed(used: number, adding: number, limit: number | null): boolean {
  return limit !== null && used + adding > limit;
}

export function meterState(used: number, limit: number | null): MeterState {
  if (limit === null) return 'OK';
  if (limit === 0 || used >= limit) return 'FULL';
  return used >= limit * WARN_AT ? 'WARN' : 'OK';
}

export function meterPercent(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit === 0) return 100;
  return Math.round((used / limit) * 1000) / 10;
}

/**
 * The warning level newly reached by a change from `before` to `after` usage, or null. Each level is
 * reported once: crossing 80 % reports 80, reaching the limit reports 100.
 */
export function crossedLevel(before: number, after: number, limit: number | null): 80 | 100 | null {
  if (limit === null || limit === 0) return null;
  if (before < limit && after >= limit) return 100;
  if (before < limit * WARN_AT && after >= limit * WARN_AT) return 80;
  return null;
}

/** Upload caps: the effective limit is min(platform, plan, school) (04 §17.8). */
export function capUploadSettings<T extends { maxDocumentMb: number; maxVideoGb: number }>(
  settings: T,
  limits: PlanLimits,
): T {
  return {
    ...settings,
    maxDocumentMb: Math.min(settings.maxDocumentMb, limits.maxDocumentMb),
    maxVideoGb: Math.min(settings.maxVideoGb, limits.maxVideoGb),
  };
}
