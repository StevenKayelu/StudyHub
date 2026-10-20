import { describe, expect, it } from 'vitest';

import {
  balanceDueAt,
  balanceReminderTimes,
  depositPlanProblems,
  minDepositFor,
  planOffered,
} from './deposit-rules';

const rules = { enabled: true, minDepositPct: 20, maxBalanceDays: 90 };
const plan = { depositMinor: 10_000, lessonPct: 30, balanceDueDays: 30 };

describe('deposit plan rules', () => {
  it('rounds the minimum deposit up to the ngwee', () => {
    expect(minDepositFor(25_001, 20)).toBe(5001);
    expect(minDepositFor(25_000, 20)).toBe(5000);
  });

  it('accepts a plan within the school rules', () => {
    expect(depositPlanProblems(25_000, plan, rules)).toEqual([]);
    expect(planOffered(25_000, plan, rules)).toBe(true);
  });

  it('refuses every plan while the school has deposit plans off', () => {
    expect(depositPlanProblems(25_000, plan, { ...rules, enabled: false }).map((p) => p.code)).toEqual([
      'DEPOSIT_PLANS_OFF',
    ]);
    expect(planOffered(25_000, plan, { ...rules, enabled: false })).toBe(false);
  });

  it('refuses free courses, deposits at or above the price and below the minimum share', () => {
    expect(depositPlanProblems(0, plan, rules).map((p) => p.code)).toEqual(['NOT_PAID']);
    expect(depositPlanProblems(10_000, plan, rules).map((p) => p.code)).toEqual(['DEPOSIT_TOO_HIGH']);
    expect(depositPlanProblems(60_000, plan, rules).map((p) => p.code)).toEqual(['DEPOSIT_TOO_LOW']);
  });

  it('refuses more days than the school allows', () => {
    const long = { ...plan, balanceDueDays: 91 };
    expect(depositPlanProblems(25_000, long, rules).map((p) => p.field)).toEqual([
      'depositPlan.balanceDueDays',
    ]);
  });

  it('stops offering a stored plan that no longer fits a changed price', () => {
    expect(planOffered(8000, plan, rules)).toBe(false);
    expect(planOffered(25_000, null, rules)).toBe(false);
  });

  it('dates the balance and its reminders from the deposit payment', () => {
    const paid = new Date('2026-10-01T10:00:00Z');
    const due = balanceDueAt(paid, 30);
    expect(due.toISOString()).toBe('2026-10-31T10:00:00.000Z');
    expect(balanceReminderTimes(due, paid).map((d) => d.toISOString())).toEqual([
      '2026-10-28T10:00:00.000Z',
      '2026-10-31T10:00:00.000Z',
    ]);
    expect(balanceReminderTimes(due, new Date('2026-10-29T00:00:00Z'))).toHaveLength(1);
    expect(balanceReminderTimes(balanceDueAt(paid, 1), paid)).toHaveLength(1);
  });
});
