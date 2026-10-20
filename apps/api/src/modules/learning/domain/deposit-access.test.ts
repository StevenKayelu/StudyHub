import { describe, expect, it } from 'vitest';

import { lockedLessonIds, openLessonCount } from './deposit-access';

const lessons = (n: number, previews: number[] = []) =>
  Array.from({ length: n }, (_, i) => ({ id: `l${i + 1}`, isPreview: previews.includes(i + 1) }));

describe('what a deposit opens', () => {
  it('opens the rounded-up share of lessons, and everything without a limit', () => {
    expect(openLessonCount(10, 30)).toBe(3);
    expect(openLessonCount(10, 25)).toBe(3);
    expect(openLessonCount(3, 1)).toBe(1);
    expect(openLessonCount(0, 50)).toBe(0);
    expect(openLessonCount(7, null)).toBe(7);
  });

  it('locks the lessons after the open share, in reading order', () => {
    expect([...lockedLessonIds(lessons(5), 40)]).toEqual(['l3', 'l4', 'l5']);
    expect(lockedLessonIds(lessons(5), null).size).toBe(0);
  });

  it('never locks preview lessons', () => {
    expect([...lockedLessonIds(lessons(5, [4]), 40)]).toEqual(['l3', 'l5']);
  });

  it('counts lessons added after the deposit (PROPOSED 1)', () => {
    expect(lockedLessonIds(lessons(4), 50).size).toBe(2);
    expect(lockedLessonIds(lessons(10), 50).size).toBe(5);
  });
});
