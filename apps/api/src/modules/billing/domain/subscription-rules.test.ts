import { describe, expect, it } from 'vitest';

import { canTransition, dunningPath, noticeTimes, suspensionDate } from './subscription-rules';

const day = (iso: string) => new Date(`${iso}T09:00:00Z`);

describe('subscription lifecycle', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('TRIALING', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'SUSPENDED')).toBe(false); // always through PAST_DUE
    expect(canTransition('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(canTransition('CANCELLED', 'ACTIVE')).toBe(false);
    expect(canTransition('PAST_DUE', 'PAST_DUE')).toBe(true);
  });
});

describe('dunning', () => {
  const unpaid = [{ dueAt: day('2027-03-01') }, { dueAt: day('2027-04-01') }];

  it('does nothing before an invoice is due', () => {
    expect(dunningPath({ status: 'ACTIVE', unpaid, graceDays: 7, now: day('2027-02-28') })).toEqual([]);
  });

  it('is past due once an invoice passes its due date, and suspends only after the grace period', () => {
    expect(dunningPath({ status: 'ACTIVE', unpaid, graceDays: 7, now: day('2027-03-02') })).toEqual([
      'PAST_DUE',
    ]);
    expect(dunningPath({ status: 'PAST_DUE', unpaid, graceDays: 7, now: day('2027-03-07') })).toEqual([]);
    expect(dunningPath({ status: 'PAST_DUE', unpaid, graceDays: 7, now: day('2027-03-08') })).toEqual([
      'SUSPENDED',
    ]);
    // A worker that missed days still passes through PAST_DUE first.
    expect(dunningPath({ status: 'ACTIVE', unpaid, graceDays: 7, now: day('2027-03-20') })).toEqual([
      'PAST_DUE',
      'SUSPENDED',
    ]);
    expect(dunningPath({ status: 'SUSPENDED', unpaid, graceDays: 7, now: day('2027-05-01') })).toEqual([]);
  });

  it('recovers when nothing is overdue any more, and never touches a cancelled subscription', () => {
    expect(dunningPath({ status: 'SUSPENDED', unpaid: [], graceDays: 7, now: day('2027-05-01') })).toEqual([
      'ACTIVE',
    ]);
    expect(
      dunningPath({
        status: 'PAST_DUE',
        unpaid: [{ dueAt: day('2027-06-01') }],
        graceDays: 7,
        now: day('2027-05-01'),
      }),
    ).toEqual(['ACTIVE']);
    expect(dunningPath({ status: 'CANCELLED', unpaid, graceDays: 0, now: day('2028-01-01') })).toEqual([]);
  });

  it('dates the suspension from the oldest overdue invoice', () => {
    expect(suspensionDate(unpaid, 7, day('2027-04-02'))).toEqual(day('2027-03-08'));
    expect(suspensionDate(unpaid, 7, day('2027-02-01'))).toBeNull();
  });
});

describe('invoice reminders', () => {
  it('schedules due-soon, due-today and overdue notices still ahead of the issue time', () => {
    const issued = day('2027-03-01');
    expect(noticeTimes(issued, day('2027-03-15')).map((n) => n.kind)).toEqual([
      'DUE_SOON',
      'DUE_TODAY',
      'OVERDUE',
    ]);
    expect(noticeTimes(issued, day('2027-03-02')).map((n) => n.kind)).toEqual(['DUE_TODAY', 'OVERDUE']);
    expect(noticeTimes(issued, issued).map((n) => n.kind)).toEqual(['OVERDUE']);
  });
});
