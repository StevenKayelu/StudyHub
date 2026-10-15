import { describe, expect, it } from 'vitest';

import {
  acceptsAnswers,
  deadlineFor,
  overdue,
  questionProblems,
  quizProblems,
  reviewVisibility,
  shuffled,
  windowState,
} from './quiz-rules';

const at = (iso: string) => new Date(iso);
const opts = (...correct: boolean[]) => correct.map((isCorrect) => ({ isCorrect }));

describe('question validation (F17 AC 1)', () => {
  it('single choice needs exactly one correct option', () => {
    expect(questionProblems({ type: 'SINGLE_CHOICE', options: opts(true, false), settings: {} })).toEqual([]);
    expect(
      questionProblems({ type: 'SINGLE_CHOICE', options: opts(false, false), settings: {} }),
    ).toHaveLength(1);
    expect(questionProblems({ type: 'SINGLE_CHOICE', options: opts(true, true), settings: {} })).toHaveLength(
      1,
    );
  });

  it('multiple choice needs at least one correct option and 2–10 options', () => {
    expect(questionProblems({ type: 'MULTIPLE_CHOICE', options: opts(true, true), settings: {} })).toEqual(
      [],
    );
    expect(
      questionProblems({ type: 'MULTIPLE_CHOICE', options: opts(false, false), settings: {} }),
    ).toHaveLength(1);
    expect(questionProblems({ type: 'MULTIPLE_CHOICE', options: opts(true), settings: {} })).toHaveLength(1);
    expect(
      questionProblems({
        type: 'MULTIPLE_CHOICE',
        options: opts(...Array<boolean>(11).fill(true)),
        settings: {},
      }),
    ).toHaveLength(1);
  });

  it('short answers need an accepted answer; numeric questions a value', () => {
    expect(
      questionProblems({ type: 'SHORT_ANSWER', options: [], settings: { acceptedAnswers: [' '] } }),
    ).toHaveLength(1);
    expect(
      questionProblems({ type: 'SHORT_ANSWER', options: [], settings: { acceptedAnswers: ['x'] } }),
    ).toEqual([]);
    expect(questionProblems({ type: 'NUMERIC', options: [], settings: {} })).toHaveLength(1);
    expect(questionProblems({ type: 'NUMERIC', options: [], settings: { value: 0 } })).toEqual([]);
    expect(questionProblems({ type: 'LONG_ANSWER', options: [], settings: {} })).toEqual([]);
  });
});

describe('time (BR-18)', () => {
  const start = at('2026-10-15T09:00:00Z');

  it('the deadline is the earlier of the time limit and the closing time', () => {
    expect(deadlineFor(start, 1200, null)).toEqual(at('2026-10-15T09:20:00Z'));
    expect(deadlineFor(start, 1200, at('2026-10-15T09:10:00Z'))).toEqual(at('2026-10-15T09:10:00Z'));
    expect(deadlineFor(start, null, at('2026-10-15T10:00:00Z'))).toEqual(at('2026-10-15T10:00:00Z'));
    expect(deadlineFor(start, null, null)).toBeNull();
  });

  it('answers are accepted until 30 s after the deadline (F19 AC 4)', () => {
    const deadline = at('2026-10-15T09:20:00Z');
    expect(acceptsAnswers(deadline, at('2026-10-15T09:20:30Z'))).toBe(true);
    expect(acceptsAnswers(deadline, at('2026-10-15T09:20:30.001Z'))).toBe(false);
    expect(overdue(deadline, at('2026-10-15T09:21:00Z'))).toBe(true);
    expect(acceptsAnswers(null, at('2099-01-01T00:00:00Z'))).toBe(true);
  });

  it('the availability window', () => {
    const quiz = { opensAt: at('2026-10-15T08:00:00Z'), closesAt: at('2026-10-15T18:00:00Z') };
    expect(windowState(quiz, at('2026-10-15T07:59:59Z'))).toBe('NOT_YET_OPEN');
    expect(windowState(quiz, at('2026-10-15T12:00:00Z'))).toBe('OPEN');
    expect(windowState(quiz, at('2026-10-15T18:00:00Z'))).toBe('CLOSED');
    expect(windowState({ opensAt: null, closesAt: null }, start)).toBe('OPEN');
  });
});

describe('feedback policy (F21, BR-20)', () => {
  const now = at('2026-10-15T12:00:00Z');
  const policy = (feedbackPolicy: 'IMMEDIATE' | 'AFTER_CLOSE' | 'NEVER', closesAt: string | null = null) => ({
    feedbackPolicy,
    showCorrectAnswers: true,
    closesAt,
  });

  it('IMMEDIATE shows everything; correct answers follow the setting', () => {
    expect(reviewVisibility(policy('IMMEDIATE'), now, false)).toMatchObject({
      details: true,
      correctAnswers: true,
    });
    expect(
      reviewVisibility({ ...policy('IMMEDIATE'), showCorrectAnswers: false }, now, false).correctAnswers,
    ).toBe(false);
  });

  it('AFTER_CLOSE hides details until the quiz closes, then shows them by itself (F21 AC)', () => {
    const before = reviewVisibility(policy('AFTER_CLOSE', '2026-10-15T18:00:00Z'), now, false);
    expect(before).toEqual({
      score: true,
      details: false,
      correctAnswers: false,
      opensAt: at('2026-10-15T18:00:00Z'),
    });
    const after = reviewVisibility(policy('AFTER_CLOSE', '2026-10-15T11:00:00Z'), now, false);
    expect(after).toEqual({ score: true, details: true, correctAnswers: true, opensAt: null });
  });

  it('NEVER shows nothing to learners; staff always see everything', () => {
    expect(reviewVisibility(policy('NEVER'), now, false)).toMatchObject({ score: false, details: false });
    expect(reviewVisibility(policy('NEVER'), now, true)).toMatchObject({ score: true, details: true });
  });
});

describe('quiz checklist (F18 AC 1)', () => {
  const base = {
    selectionMode: 'FIXED' as const,
    itemCount: 1,
    drawRules: [],
    feedbackPolicy: 'IMMEDIATE' as const,
    closesAt: null,
  };

  it('a quiz needs questions, and draw rules the bank can satisfy', () => {
    expect(quizProblems(base)).toEqual([]);
    expect(quizProblems({ ...base, itemCount: 0 })).toHaveLength(1);
    expect(
      quizProblems({ ...base, selectionMode: 'DRAW', drawRules: [{ count: 5, available: 4 }] }),
    ).toHaveLength(1);
    expect(quizProblems({ ...base, selectionMode: 'DRAW', drawRules: [{ count: 5, available: 5 }] })).toEqual(
      [],
    );
  });

  it('results after closing need a closing time', () => {
    expect(quizProblems({ ...base, feedbackPolicy: 'AFTER_CLOSE' })).toHaveLength(1);
  });
});

describe('shuffle', () => {
  it('keeps every item exactly once', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const result = shuffled([1, 2, 3, 4, 5, 6], random);
    expect([...result].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result).not.toEqual([1, 2, 3, 4, 5, 6]);
  });
});
