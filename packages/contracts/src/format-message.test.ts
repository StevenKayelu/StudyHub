import { describe, expect, it } from 'vitest';

import { formatMessage } from './format-message';

describe('formatMessage', () => {
  it('fills placeholders', () => {
    expect(formatMessage('Hello {name}', { name: 'Ada' })).toBe('Hello Ada');
  });

  it('chooses ICU plural forms and replaces #', () => {
    const template = '{count, plural, =0 {No quizzes} one {# quiz} other {# quizzes}}';
    expect(formatMessage(template, { count: 0 })).toBe('No quizzes');
    expect(formatMessage(template, { count: 1 })).toBe('1 quiz');
    expect(formatMessage(template, { count: 1200 })).toBe('1,200 quizzes');
  });

  it('mixes plurals with placeholders', () => {
    expect(
      formatMessage('Total: {points} · {count, plural, one {# question} other {# questions}}', {
        points: 7,
        count: 4,
      }),
    ).toBe('Total: 7 · 4 questions');
  });
});
