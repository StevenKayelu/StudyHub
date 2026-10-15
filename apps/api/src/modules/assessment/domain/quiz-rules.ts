/**
 * Question and quiz rules (F17, F18, F19, F21, BR-16 to BR-18, BR-20).
 * Framework-free: the services load data, these decide.
 */
import type { QuestionType } from './scoring';

/** BR-18: answers in flight are still accepted for this long after the deadline. */
export const GRACE_SECONDS = 30;

export interface FieldProblem {
  field: string;
  message: string;
}

/**
 * F17 AC 1: choice questions have 2–10 options; single choice and true/false exactly one correct, multiple
 * choice at least one. Short answers need an accepted answer; numeric questions a value.
 */
export function questionProblems(input: {
  type: QuestionType;
  options: readonly { isCorrect: boolean }[];
  settings: { acceptedAnswers?: string[] | undefined; value?: number | undefined };
}): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const correct = input.options.filter((o) => o.isCorrect).length;
  switch (input.type) {
    case 'SINGLE_CHOICE':
    case 'MULTIPLE_CHOICE':
      if (input.options.length < 2 || input.options.length > 10) {
        problems.push({ field: 'options', message: 'Give between 2 and 10 options' });
      }
      if (input.type === 'SINGLE_CHOICE' && correct !== 1) {
        problems.push({ field: 'options', message: 'Mark exactly one correct answer' });
      }
      if (input.type === 'MULTIPLE_CHOICE' && correct < 1) {
        problems.push({ field: 'options', message: 'Mark at least one correct answer' });
      }
      break;
    case 'TRUE_FALSE':
      if (input.options.length !== 2 || correct !== 1) {
        problems.push({ field: 'options', message: 'Mark whether the statement is true or false' });
      }
      break;
    case 'SHORT_ANSWER':
      if ((input.settings.acceptedAnswers ?? []).every((a) => a.trim() === '')) {
        problems.push({ field: 'settings.acceptedAnswers', message: 'Add at least one accepted answer' });
      }
      break;
    case 'NUMERIC':
      if (input.settings.value === undefined || !Number.isFinite(input.settings.value)) {
        problems.push({ field: 'settings.value', message: 'Enter the correct value' });
      }
      break;
    case 'LONG_ANSWER':
      break;
  }
  return problems;
}

/** Whether learners can start the quiz now (F18 availability window). */
export function windowState(
  quiz: { opensAt: Date | null; closesAt: Date | null },
  now: Date,
): 'OPEN' | 'NOT_YET_OPEN' | 'CLOSED' {
  if (quiz.opensAt !== null && now < quiz.opensAt) return 'NOT_YET_OPEN';
  if (quiz.closesAt !== null && now >= quiz.closesAt) return 'CLOSED';
  return 'OPEN';
}

/** BR-18: deadlineAt = min(startedAt + time limit, closesAt); null when neither applies. */
export function deadlineFor(
  startedAt: Date,
  timeLimitSeconds: number | null,
  closesAt: Date | null,
): Date | null {
  const byLimit = timeLimitSeconds === null ? null : new Date(startedAt.getTime() + timeLimitSeconds * 1000);
  if (byLimit === null) return closesAt;
  if (closesAt === null) return byLimit;
  return byLimit < closesAt ? byLimit : closesAt;
}

/** BR-18: an answer is accepted until the deadline plus the grace period. */
export function acceptsAnswers(deadlineAt: Date | null, now: Date): boolean {
  return deadlineAt === null || now.getTime() <= deadlineAt.getTime() + GRACE_SECONDS * 1000;
}

/** Whether the attempt is past its deadline and grace, so it must be auto-submitted (F19 AC 3). */
export function overdue(deadlineAt: Date | null, now: Date): boolean {
  return !acceptsAnswers(deadlineAt, now);
}

export type FeedbackPolicy = 'IMMEDIATE' | 'AFTER_CLOSE' | 'NEVER';

export interface ReviewVisibility {
  score: boolean;
  /** Per-question review: the learner's own answers and points. */
  details: boolean;
  /** Correct answers and explanations (BR-20, show_correct_answers). */
  correctAnswers: boolean;
  /** AFTER_CLOSE before closing: when the review opens. */
  opensAt: Date | null;
}

/**
 * F21 / BR-20: what a learner sees of a submitted attempt. Staff (the course owner and school
 * administrators) always see everything. With AFTER_CLOSE the details appear at `closesAt` without any
 * action from the tutor; without a closing time they never do (PROPOSED: the quiz checklist requires one).
 */
export function reviewVisibility(
  settings: { feedbackPolicy: FeedbackPolicy; showCorrectAnswers: boolean; closesAt: string | null },
  now: Date,
  staff: boolean,
): ReviewVisibility {
  if (staff) return { score: true, details: true, correctAnswers: true, opensAt: null };
  switch (settings.feedbackPolicy) {
    case 'NEVER':
      return { score: false, details: false, correctAnswers: false, opensAt: null };
    case 'IMMEDIATE':
      return { score: true, details: true, correctAnswers: settings.showCorrectAnswers, opensAt: null };
    case 'AFTER_CLOSE': {
      const closesAt = settings.closesAt === null ? null : new Date(settings.closesAt);
      const open = closesAt !== null && now >= closesAt;
      return {
        score: true,
        details: open,
        correctAnswers: open && settings.showCorrectAnswers,
        opensAt: open ? null : closesAt,
      };
    }
  }
}

/** Quiz checklist (F18 AC 1): what stops a quiz from being made available. */
export function quizProblems(quiz: {
  selectionMode: 'FIXED' | 'DRAW';
  itemCount: number;
  drawRules: readonly { count: number; available: number }[];
  feedbackPolicy: FeedbackPolicy;
  closesAt: Date | null;
}): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (quiz.selectionMode === 'FIXED' && quiz.itemCount === 0) {
    problems.push({ field: 'items', message: 'Add at least one question' });
  }
  if (quiz.selectionMode === 'DRAW') {
    if (quiz.drawRules.length === 0)
      problems.push({ field: 'drawRules', message: 'Add at least one draw rule' });
    const short = quiz.drawRules.filter((rule) => rule.available < rule.count);
    if (short.length > 0) {
      problems.push({
        field: 'drawRules',
        message: 'A draw rule asks for more questions than the bank has that match it',
      });
    }
  }
  if (quiz.feedbackPolicy === 'AFTER_CLOSE' && quiz.closesAt === null) {
    problems.push({ field: 'closesAt', message: 'Results after closing need a closing time' });
  }
  return problems;
}

/** Fisher–Yates shuffle with an injectable random source (tests pass a seeded one). */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}
