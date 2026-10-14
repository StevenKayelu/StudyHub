import { describe, expect, it } from 'vitest';

import { courseProgress, nextLessonState, reachesThreshold } from './progress-rules';

const lessons = [
  { id: 'a', isRequired: true },
  { id: 'b', isRequired: true },
  { id: 'c', isRequired: true },
  { id: 'optional', isRequired: false },
];

describe('course progress (F15, BR-22)', () => {
  it('counts completed required lessons over required lessons, rounded down', () => {
    expect(courseProgress(lessons, new Set(['a']))).toEqual({
      required: 3,
      completedRequired: 1,
      percent: 33,
      complete: false,
    });
  });

  it('ignores optional lessons when some are required', () => {
    expect(courseProgress(lessons, new Set(['optional', 'a', 'b'])).percent).toBe(66);
  });

  it('is complete when every required lesson is complete', () => {
    expect(courseProgress(lessons, new Set(['a', 'b', 'c']))).toMatchObject({ percent: 100, complete: true });
  });

  it('counts every lesson when none is required', () => {
    const allOptional = lessons.map((lesson) => ({ ...lesson, isRequired: false }));
    expect(courseProgress(allOptional, new Set(['a', 'b']))).toMatchObject({ required: 4, percent: 50 });
  });

  it('an empty course is never complete', () => {
    expect(courseProgress([], new Set())).toEqual({
      required: 0,
      completedRequired: 0,
      percent: 0,
      complete: false,
    });
  });
});

describe('video completion threshold (BR-64)', () => {
  it('completes at the threshold share of the duration', () => {
    expect(reachesThreshold(89, 100, 90)).toBe(false);
    expect(reachesThreshold(90, 100, 90)).toBe(true);
    expect(reachesThreshold(54, 60, 90)).toBe(true);
  });

  it('never completes by position when the duration is unknown', () => {
    expect(reachesThreshold(1000, null, 90)).toBe(false);
    expect(reachesThreshold(1000, 0, 90)).toBe(false);
  });
});

describe('next lesson state', () => {
  const base = { durationSeconds: 100, thresholdPct: 90, current: null } as const;

  it('marks a text lesson complete on request', () => {
    expect(nextLessonState({ ...base, lessonType: 'TEXT', requested: { status: 'COMPLETED' } })).toEqual({
      status: 'COMPLETED',
      positionSeconds: 0,
    });
  });

  it('keeps a video in progress until the threshold, whatever the client asks', () => {
    expect(
      nextLessonState({
        ...base,
        lessonType: 'VIDEO',
        requested: { status: 'COMPLETED', positionSeconds: 30 },
      }),
    ).toEqual({ status: 'IN_PROGRESS', positionSeconds: 30 });
    expect(nextLessonState({ ...base, lessonType: 'VIDEO', requested: { positionSeconds: 95 } }).status).toBe(
      'COMPLETED',
    );
  });

  it('lets a video of unknown length be completed by hand', () => {
    expect(
      nextLessonState({
        ...base,
        durationSeconds: null,
        lessonType: 'VIDEO',
        requested: { status: 'COMPLETED' },
      }).status,
    ).toBe('COMPLETED');
  });

  it('never goes back from COMPLETED, but still records the position', () => {
    expect(
      nextLessonState({
        ...base,
        lessonType: 'VIDEO',
        current: { status: 'COMPLETED', positionSeconds: 95 },
        requested: { status: 'IN_PROGRESS', positionSeconds: 10 },
      }),
    ).toEqual({ status: 'COMPLETED', positionSeconds: 10 });
  });

  it('keeps the saved position when only a status is sent', () => {
    expect(
      nextLessonState({
        ...base,
        lessonType: 'VIDEO',
        current: { status: 'IN_PROGRESS', positionSeconds: 42 },
        requested: { status: 'IN_PROGRESS' },
      }).positionSeconds,
    ).toBe(42);
  });

  it('never completes a quiz lesson here (M7 attempts do)', () => {
    expect(nextLessonState({ ...base, lessonType: 'QUIZ', requested: { status: 'COMPLETED' } }).status).toBe(
      'IN_PROGRESS',
    );
  });
});
