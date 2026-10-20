/**
 * What a deposit opens (docs/design/payment-plans.md): the first `pct` % of the lessons in reading order,
 * rounded up, plus every preview lesson. `pct` null means the whole course.
 */
export function openLessonCount(total: number, pct: number | null): number {
  if (pct === null) return total;
  return Math.min(total, Math.ceil((total * pct) / 100));
}

/** Lessons beyond what the deposit opened (empty without a limit). `lessons` is in reading order. */
export function lockedLessonIds(
  lessons: readonly { id: string; isPreview: boolean }[],
  pct: number | null,
): Set<string> {
  const open = openLessonCount(lessons.length, pct);
  return new Set(
    lessons
      .slice(open)
      .filter((lesson) => !lesson.isPreview)
      .map((lesson) => lesson.id),
  );
}
