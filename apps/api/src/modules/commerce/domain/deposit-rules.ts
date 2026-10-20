/**
 * Deposit plans as plain functions (docs/design/payment-plans.md). Amounts are integers in minor units.
 */

export interface DepositPlanInput {
  depositMinor: number;
  lessonPct: number;
  balanceDueDays: number;
}

export interface DepositRules {
  enabled: boolean;
  minDepositPct: number;
  maxBalanceDays: number;
}

export interface PlanProblem {
  field: 'depositPlan.depositMinor' | 'depositPlan.balanceDueDays' | 'depositPlan';
  code: 'DEPOSIT_PLANS_OFF' | 'NOT_PAID' | 'DEPOSIT_TOO_HIGH' | 'DEPOSIT_TOO_LOW' | 'TOO_LONG';
  message: string;
}

/** The smallest deposit the school allows for a price: `minDepositPct` %, rounded up to the ngwee. */
export function minDepositFor(priceMinor: number, minDepositPct: number): number {
  return Math.ceil((priceMinor * minDepositPct) / 100);
}

/** Why a tutor's plan can't be saved with this price and these school rules (empty: it can). */
export function depositPlanProblems(
  priceMinor: number,
  plan: DepositPlanInput,
  rules: DepositRules,
): PlanProblem[] {
  if (!rules.enabled) {
    return [
      {
        field: 'depositPlan',
        code: 'DEPOSIT_PLANS_OFF',
        message: 'This school does not offer deposit plans.',
      },
    ];
  }
  if (priceMinor <= 0) {
    return [{ field: 'depositPlan', code: 'NOT_PAID', message: 'Only paid courses can take a deposit.' }];
  }
  const problems: PlanProblem[] = [];
  if (plan.depositMinor >= priceMinor) {
    problems.push({
      field: 'depositPlan.depositMinor',
      code: 'DEPOSIT_TOO_HIGH',
      message: 'The deposit must be less than the price.',
    });
  } else if (plan.depositMinor < minDepositFor(priceMinor, rules.minDepositPct)) {
    problems.push({
      field: 'depositPlan.depositMinor',
      code: 'DEPOSIT_TOO_LOW',
      message: `The deposit must be at least ${rules.minDepositPct}% of the price.`,
    });
  }
  if (plan.balanceDueDays > rules.maxBalanceDays) {
    problems.push({
      field: 'depositPlan.balanceDueDays',
      code: 'TOO_LONG',
      message: `Learners can have at most ${rules.maxBalanceDays} days to pay the balance.`,
    });
  }
  return problems;
}

/** Whether a stored plan may be offered now: the school allows plans and it still fits price and rules. */
export function planOffered(
  priceMinor: number,
  plan: DepositPlanInput | null,
  rules: DepositRules,
): plan is DepositPlanInput {
  return plan !== null && depositPlanProblems(priceMinor, plan, rules).length === 0;
}

const DAY_MS = 86_400_000;

/** When the balance is due: `balanceDueDays` after the deposit was paid. */
export function balanceDueAt(paidAt: Date, balanceDueDays: number): Date {
  return new Date(paidAt.getTime() + balanceDueDays * DAY_MS);
}

/** Reminder times (PROPOSED 3): 3 days before the deadline and on it, skipping any already past. */
export function balanceReminderTimes(dueAt: Date, now: Date): Date[] {
  return [new Date(dueAt.getTime() - 3 * DAY_MS), dueAt].filter((at) => at > now);
}
