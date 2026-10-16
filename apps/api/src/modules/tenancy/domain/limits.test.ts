import { DEFAULT_PLAN_LIMITS } from '@studyhub/contracts';
import { describe, expect, it } from 'vitest';

import {
  capUploadSettings,
  crossedLevel,
  limitOf,
  limitsFrom,
  meterPercent,
  meterState,
  wouldExceed,
} from './limits';

describe('plan limits (BR-49)', () => {
  it('reads stored limits field by field, falling back to the defaults', () => {
    expect(limitsFrom(null)).toEqual(DEFAULT_PLAN_LIMITS);
    expect(limitsFrom({ maxInstructors: 3, storageGb: 'lots' })).toEqual({
      ...DEFAULT_PLAN_LIMITS,
      maxInstructors: 3,
    });
    expect(limitsFrom({ maxActiveLearners: null }).maxActiveLearners).toBeNull();
  });

  it('converts storage to bytes and treats null as unlimited', () => {
    expect(limitOf({ ...DEFAULT_PLAN_LIMITS, storageGb: 1 }, 'storage')).toBe(1024 ** 3);
    expect(limitOf({ ...DEFAULT_PLAN_LIMITS, maxAdmins: null }, 'admins')).toBeNull();
    expect(wouldExceed(10, 1, null)).toBe(false);
    expect(wouldExceed(4, 1, 5)).toBe(false);
    expect(wouldExceed(5, 1, 5)).toBe(true);
  });

  it('meters: OK below 80 %, WARN from 80 %, FULL at the limit', () => {
    expect(meterState(79, 100)).toBe('OK');
    expect(meterState(80, 100)).toBe('WARN');
    expect(meterState(100, 100)).toBe('FULL');
    expect(meterState(5, null)).toBe('OK');
    expect(meterPercent(1, 3)).toBe(33.3);
    expect(meterPercent(1, null)).toBeNull();
  });

  it('reports each warning level once, when it is crossed', () => {
    expect(crossedLevel(79, 80, 100)).toBe(80);
    expect(crossedLevel(80, 81, 100)).toBeNull();
    expect(crossedLevel(99, 100, 100)).toBe(100);
    expect(crossedLevel(70, 100, 100)).toBe(100);
    expect(crossedLevel(1, 2, null)).toBeNull();
  });

  it('caps a school’s upload sizes by its plan', () => {
    expect(
      capUploadSettings(
        { maxDocumentMb: 200, maxVideoGb: 10 },
        { ...DEFAULT_PLAN_LIMITS, maxDocumentMb: 50 },
      ),
    ).toEqual({ maxDocumentMb: 50, maxVideoGb: 4 });
  });
});
