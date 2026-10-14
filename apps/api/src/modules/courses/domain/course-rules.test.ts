import { describe, expect, it } from 'vitest';

import { type ChecklistInput, evaluateChecklist, nextFreeSlug, nextStatus, slugify } from './course-rules';

describe('slugs (BR-59)', () => {
  it('makes readable, ASCII, hyphenated slugs', () => {
    expect(slugify('Biology: Cells & More!')).toBe('biology-cells-and-more');
    expect(slugify('Mathématiques avancées')).toBe('mathematiques-avancees');
    expect(slugify('!!!')).toBe('item');
  });

  it('finds the first free variant', () => {
    expect(nextFreeSlug('biology', new Set())).toBe('biology');
    expect(nextFreeSlug('biology', new Set(['biology', 'biology-2']))).toBe('biology-3');
  });
});

describe('course states (F12)', () => {
  const review = { reviewRequired: true, everPublished: false };
  it('sends a first submission to review, or straight to published when review is off', () => {
    expect(nextStatus('DRAFT', 'submit', review)).toBe('IN_REVIEW');
    expect(nextStatus('DRAFT', 'submit', { ...review, reviewRequired: false })).toBe('PUBLISHED');
    expect(nextStatus('CHANGES_REQUESTED', 'submit', review)).toBe('IN_REVIEW');
  });

  it('allows only the documented transitions', () => {
    expect(nextStatus('IN_REVIEW', 'approve', review)).toBe('PUBLISHED');
    expect(nextStatus('IN_REVIEW', 'requestChanges', review)).toBe('CHANGES_REQUESTED');
    expect(nextStatus('PUBLISHED', 'unpublish', review)).toBe('UNPUBLISHED');
    expect(nextStatus('UNPUBLISHED', 'republish', review)).toBe('PUBLISHED');
    expect(nextStatus('PUBLISHED', 'archive', review)).toBeNull();
    expect(nextStatus('DRAFT', 'approve', review)).toBeNull();
    expect(nextStatus('PUBLISHED', 'submit', review)).toBeNull();
  });
});

describe('publish checklist (BR-04)', () => {
  const ready: ChecklistInput = {
    title: 'Cell biology',
    subtitle: 'From membranes to mitochondria',
    descriptionLength: 240,
    subjectId: 'subject',
    coverReady: true,
    outcomes: 2,
    priceMinor: 0,
    minPaidPriceMinor: 1000,
    paymentsAvailable: false,
    sections: [{ lessons: [{ title: 'Intro', ready: true, type: 'TEXT' }] }],
  };

  it('passes a complete free course', () => {
    expect(evaluateChecklist('c', ready).every((item) => item.ok)).toBe(true);
  });

  it('lists every failing item with a link to fix it (F12 AC 1)', () => {
    const items = evaluateChecklist('c', {
      ...ready,
      descriptionLength: 50,
      coverReady: false,
      sections: [{ lessons: [{ title: 'Empty', ready: false, type: 'VIDEO' }] }],
    });
    const failing = items.filter((item) => !item.ok);
    expect(failing.map((item) => item.key)).toEqual(['description', 'cover', 'lessonContent']);
    expect(failing[0]!.fixPath).toBe('/studio/courses/c/details');
    expect(failing[2]!.message).toContain('"Empty"');
  });

  it('blocks paid courses until payments exist (BR-54)', () => {
    const items = evaluateChecklist('c', { ...ready, priceMinor: 25_000 });
    expect(items.find((item) => item.key === 'payments')?.ok).toBe(false);
  });
});
