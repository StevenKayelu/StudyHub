import { describe, expect, it } from 'vitest';

import {
  type AnswerResponse,
  attemptTotals,
  correctAnswer,
  normaliseText,
  publicQuestion,
  type QuestionSnapshot,
  type QuestionType,
  responseFits,
  scoreAnswer,
} from './scoring';

const option = (id: string, isCorrect: boolean) => ({
  id,
  content: `option ${id}`,
  isCorrect,
  feedback: null,
});

function snapshot(type: QuestionType, overrides: Partial<QuestionSnapshot> = {}): QuestionSnapshot {
  return {
    type,
    stem: 'stem',
    options: [],
    settings: {},
    explanation: 'because',
    tags: [],
    difficulty: 'MEDIUM',
    ...overrides,
  };
}

const single = snapshot('SINGLE_CHOICE', {
  options: [option('a', false), option('b', true), option('c', false)],
});
const trueFalse = snapshot('TRUE_FALSE', { options: [option('t', true), option('f', false)] });
// Three correct (a, b, c) and two wrong (d, e).
const multiOptions = [
  option('a', true),
  option('b', true),
  option('c', true),
  option('d', false),
  option('e', false),
];
const multi = snapshot('MULTIPLE_CHOICE', { options: multiOptions });
const multiPartial = snapshot('MULTIPLE_CHOICE', {
  options: multiOptions,
  settings: { partialCredit: true },
});
const short = snapshot('SHORT_ANSWER', { settings: { acceptedAnswers: ['Mitochondrion', 'mitochondria'] } });
const shortCase = snapshot('SHORT_ANSWER', { settings: { acceptedAnswers: ['NaCl'], caseSensitive: true } });
const numeric = snapshot('NUMERIC', { settings: { value: 9.81, tolerance: 0.05, unit: 'm/s²' } });
const exact = snapshot('NUMERIC', { settings: { value: 0.3 } });
const long = snapshot('LONG_ANSWER');

const ids = (...optionIds: string[]): AnswerResponse => ({ optionIds });

/** BR-21 scoring table (07 M7 AC 1): question, points, response → correct?, points awarded. */
const TABLE: [string, QuestionSnapshot, number, AnswerResponse | null, boolean | null, number][] = [
  ['single: the correct option', single, 2, ids('b'), true, 2],
  ['single: a wrong option', single, 2, ids('a'), false, 0],
  ['single: two options is not an answer', single, 2, ids('a', 'b'), false, 0],
  ['single: nothing chosen', single, 2, ids(), false, 0],
  ['single: no response', single, 2, null, false, 0],
  ['true/false: right', trueFalse, 1, ids('t'), true, 1],
  ['true/false: wrong', trueFalse, 1, ids('f'), false, 0],
  ['multiple: all correct, nothing wrong', multi, 3, ids('a', 'b', 'c'), true, 3],
  ['multiple: order does not matter', multi, 3, ids('c', 'a', 'b'), true, 3],
  ['multiple: all-or-nothing by default (2 of 3)', multi, 3, ids('a', 'b'), false, 0],
  ['multiple: all-or-nothing with an extra wrong one', multi, 3, ids('a', 'b', 'c', 'd'), false, 0],
  ['partial: 2 of 3 correct → 3 × 2/3', multiPartial, 3, ids('a', 'b'), false, 2],
  ['partial: 1 of 3 correct → 1 × 1/3, rounded', multiPartial, 1, ids('a'), false, 0.33],
  ['partial: 2 correct, 1 wrong → (2−1)/3', multiPartial, 3, ids('a', 'b', 'd'), false, 1],
  ['partial: 1 correct, 2 wrong → floor at 0', multiPartial, 3, ids('a', 'd', 'e'), false, 0],
  ['partial: everything ticked → (3−2)/3', multiPartial, 3, ids('a', 'b', 'c', 'd', 'e'), false, 1],
  ['partial: exactly right is full marks', multiPartial, 3, ids('a', 'b', 'c'), true, 3],
  ['partial: 2/3 of 2.5 points rounds to 2 dp', multiPartial, 2.5, ids('a', 'b'), false, 1.67],
  ['partial: unknown option ids are ignored', multiPartial, 3, ids('a', 'b', 'zzz'), false, 2],
  ['short: exact', short, 1, { text: 'Mitochondrion' }, true, 1],
  ['short: case-folded, trimmed, spaces collapsed', short, 1, { text: '  MITOCHONDRIA ' }, true, 1],
  ['short: inner whitespace collapsed', shortCase, 1, { text: 'NaCl' }, true, 1],
  ['short: case-sensitive refuses another case', shortCase, 1, { text: 'nacl' }, false, 0],
  ['short: wrong word', short, 1, { text: 'Ribosome' }, false, 0],
  ['short: empty', short, 1, { text: '   ' }, false, 0],
  ['numeric: exact value', numeric, 2, { number: 9.81 }, true, 2],
  ['numeric: inside the tolerance', numeric, 2, { number: 9.85 }, true, 2],
  ['numeric: on the tolerance edge', numeric, 2, { number: 9.76 }, true, 2],
  ['numeric: outside the tolerance', numeric, 2, { number: 9.87 }, false, 0],
  ['numeric: float noise does not fail an exact answer', exact, 1, { number: 0.1 + 0.2 }, true, 1],
  ['numeric: text is not a number', numeric, 2, { text: '9.81' }, false, 0],
  ['long: an answer waits for the tutor', long, 5, { text: 'My essay' }, null, 0],
  ['long: blank scores 0 without marking', long, 5, { text: '' }, false, 0],
];

describe('scoring table (BR-21, F20 AC 2)', () => {
  it.each(TABLE)('%s', (_name, question, points, response, isCorrect, awarded) => {
    const score = scoreAnswer(question, points, response);
    expect(score.isCorrect).toBe(isCorrect);
    expect(score.awarded).toBe(awarded);
    expect(score.needsManual).toBe(isCorrect === null);
  });
});

describe('totals (F20 AC 1)', () => {
  it('sums per-answer points and rounds the percentage', () => {
    expect(
      attemptTotals(
        [
          { points: 3, awarded: 2 },
          { points: 1, awarded: 0.33 },
          { points: 2, awarded: 2 },
        ],
        60,
      ),
    ).toEqual({ score: 4.33, maxScore: 6, percent: 72.17, passed: true });
  });

  it('passes exactly at the pass mark; no pass mark means no verdict', () => {
    expect(attemptTotals([{ points: 4, awarded: 3 }], 75).passed).toBe(true);
    expect(attemptTotals([{ points: 4, awarded: 2.99 }], 75).passed).toBe(false);
    expect(attemptTotals([{ points: 4, awarded: 3 }], null).passed).toBeNull();
  });

  it('an empty attempt is 0 %', () => {
    expect(attemptTotals([], 50)).toEqual({ score: 0, maxScore: 0, percent: 0, passed: false });
  });
});

describe('response shapes', () => {
  it('accepts only the shape and option ids of the question', () => {
    expect(responseFits(single, ids('b'))).toBe(true);
    expect(responseFits(single, ids('a', 'b'))).toBe(false);
    expect(responseFits(single, ids('x'))).toBe(false);
    expect(responseFits(multi, ids('a', 'a'))).toBe(false);
    expect(responseFits(multi, ids('a', 'd'))).toBe(true);
    expect(responseFits(numeric, { number: Number.NaN })).toBe(false);
    expect(responseFits(numeric, { text: '1' })).toBe(false);
    expect(responseFits(short, { text: 'x'.repeat(501) })).toBe(false);
  });
});

describe('no answer leakage (BR-20)', () => {
  it('the public question carries no correctness, accepted answers, values or explanations', () => {
    for (const question of [single, multiPartial, short, numeric, long]) {
      const text = JSON.stringify(publicQuestion(question));
      expect(text).not.toMatch(/isCorrect|acceptedAnswers|tolerance|explanation|because|Mitochond|9\.81/);
    }
    expect(publicQuestion(numeric)).toMatchObject({ unit: 'm/s²' });
  });

  it('the correct answer is available for reviews the policy allows', () => {
    expect(correctAnswer(multi)).toEqual({ optionIds: ['a', 'b', 'c'] });
    expect(correctAnswer(numeric)).toEqual({ value: 9.81, tolerance: 0.05 });
    expect(correctAnswer(long)).toBeNull();
  });
});

describe('text normalisation', () => {
  it('folds case and whitespace, keeps letters', () => {
    expect(normaliseText('  Cell\n  Wall ')).toBe('cell wall');
    expect(normaliseText('Cell Wall', true)).toBe('Cell Wall');
  });
});
