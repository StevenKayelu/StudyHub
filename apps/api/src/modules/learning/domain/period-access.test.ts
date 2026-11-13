import { describe, expect, it } from 'vitest';

import { periodLock, type PeriodForLock } from './period-access';

const now = new Date('2027-01-10T08:00:00Z');
const term = (over: Partial<PeriodForLock> = {}): PeriodForLock => ({
  name: 'Term 1',
  startsAt: new Date('2027-01-13T00:00:00Z'),
  mode: 'AUTO',
  ...over,
});

describe('periodLock', () => {
  it('leaves an unassigned topic open', () => {
    expect(periodLock(null, now)).toBeNull();
  });

  it('locks a topic until the period start date, then opens it', () => {
    expect(periodLock(term(), now)).toEqual({ periodName: 'Term 1', opensAt: term().startsAt });
    expect(periodLock(term(), term().startsAt)).toBeNull();
  });

  it('follows the manual switch on the period', () => {
    expect(periodLock(term({ mode: 'OPEN' }), now)).toBeNull();
    const started = term({ mode: 'LOCKED', startsAt: new Date('2026-09-01T00:00:00Z') });
    expect(periodLock(started, now)).toEqual({ periodName: 'Term 1', opensAt: null });
  });
});
