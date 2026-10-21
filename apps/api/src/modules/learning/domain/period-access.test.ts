import { describe, expect, it } from 'vitest';

import { courseLock, type PeriodForLock } from './period-access';

const now = new Date('2027-01-10T08:00:00Z');
const term = (over: Partial<PeriodForLock> = {}): PeriodForLock => ({
  name: 'Term 1',
  startsAt: new Date('2027-01-13T00:00:00Z'),
  mode: 'AUTO',
  ...over,
});

describe('courseLock', () => {
  it('leaves a course without a period open', () => {
    expect(courseLock(null, null, now)).toBeNull();
  });

  it('locks a period course until the start date, then opens it', () => {
    expect(courseLock(term(), null, now)).toEqual({ periodName: 'Term 1', opensAt: term().startsAt });
    expect(courseLock(term(), null, term().startsAt)).toBeNull();
  });

  it('follows the manual switch on the period', () => {
    expect(courseLock(term({ mode: 'OPEN' }), null, now)).toBeNull();
    const started = term({ mode: 'LOCKED', startsAt: new Date('2026-09-01T00:00:00Z') });
    expect(courseLock(started, null, now)).toEqual({ periodName: 'Term 1', opensAt: null });
  });

  it('lets the course override win over the period', () => {
    expect(courseLock(term({ mode: 'LOCKED' }), 'OPEN', now)).toBeNull();
    expect(courseLock(term({ mode: 'OPEN' }), 'LOCKED', now)).toEqual({
      periodName: 'Term 1',
      opensAt: null,
    });
  });

  it('locks an open course an administrator locked', () => {
    expect(courseLock(null, 'LOCKED', now)).toEqual({ periodName: null, opensAt: null });
  });
});
