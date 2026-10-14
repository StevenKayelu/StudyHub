/**
 * Course rules (F09, F12, BR-04, BR-05). Framework-free: the services load data, these decide.
 */

/** A URL slug from a title ("Biology: Cells & More!" → "biology-cells-more"); never empty. */
export function slugify(text: string, maxLength = 80): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug === '' ? 'item' : slug;
}

/** The first free slug: base, base-2, base-3, … (slugs are unique per school, BR-59). */
export function nextFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export type CourseStatus =
  'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'PUBLISHED' | 'UNPUBLISHED' | 'ARCHIVED';
export type CourseAction = 'submit' | 'approve' | 'requestChanges' | 'unpublish' | 'republish' | 'archive';

/**
 * Allowed transitions (05 §3.3 state diagram). `submit` goes to IN_REVIEW or straight to PUBLISHED
 * depending on `courseReviewRequired` (BR-05), and only for courses never published before; a course
 * that was published once comes back with `republish` (no re-review).
 */
export function nextStatus(
  status: CourseStatus,
  action: CourseAction,
  options: { reviewRequired: boolean; everPublished: boolean },
): CourseStatus | null {
  switch (action) {
    case 'submit':
      if (status !== 'DRAFT' && status !== 'CHANGES_REQUESTED') return null;
      return options.reviewRequired && !options.everPublished ? 'IN_REVIEW' : 'PUBLISHED';
    case 'approve':
      return status === 'IN_REVIEW' ? 'PUBLISHED' : null;
    case 'requestChanges':
      return status === 'IN_REVIEW' ? 'CHANGES_REQUESTED' : null;
    case 'unpublish':
      return status === 'PUBLISHED' ? 'UNPUBLISHED' : null;
    case 'republish':
      return status === 'UNPUBLISHED' ? 'PUBLISHED' : null;
    case 'archive':
      return status === 'DRAFT' || status === 'UNPUBLISHED' || status === 'CHANGES_REQUESTED'
        ? 'ARCHIVED'
        : null;
  }
}

/** Statuses in which the owner can still edit the outline and details. */
export const EDITABLE: ReadonlySet<CourseStatus> = new Set([
  'DRAFT',
  'CHANGES_REQUESTED',
  'PUBLISHED',
  'UNPUBLISHED',
]);

export interface ChecklistInput {
  title: string;
  subtitle: string | null;
  descriptionLength: number;
  subjectId: string | null;
  coverReady: boolean;
  outcomes: number;
  priceMinor: number;
  minPaidPriceMinor: number;
  /** Paid courses need the school's payment account (BR-54) and the instructor's payout method (BR-04): M8. */
  paymentsAvailable: boolean;
  sections: { lessons: { title: string; ready: boolean; type: string }[] }[];
}

export interface ChecklistItem {
  key: string;
  ok: boolean;
  message: string;
  fixPath: string;
}

/** BR-04 publish checklist; every failing item is listed with where to fix it (F12 AC 1). */
export function evaluateChecklist(courseId: string, input: ChecklistInput): ChecklistItem[] {
  const base = `/studio/courses/${courseId}`;
  const lessons = input.sections.flatMap((section) => section.lessons);
  const notReady = lessons.filter((lesson) => !lesson.ready);
  const items: ChecklistItem[] = [
    {
      key: 'title',
      ok: input.title.trim().length >= 5,
      message: 'A title of at least 5 characters',
      fixPath: `${base}/details`,
    },
    {
      key: 'subtitle',
      ok: (input.subtitle ?? '').trim().length > 0,
      message: 'A subtitle',
      fixPath: `${base}/details`,
    },
    {
      key: 'description',
      ok: input.descriptionLength >= 200,
      message: `A description of at least 200 characters (now ${input.descriptionLength})`,
      fixPath: `${base}/details`,
    },
    { key: 'subject', ok: input.subjectId !== null, message: 'A subject', fixPath: `${base}/details` },
    { key: 'cover', ok: input.coverReady, message: 'A cover image', fixPath: `${base}/details` },
    {
      key: 'outcomes',
      ok: input.outcomes >= 1,
      message: 'At least one learning outcome',
      fixPath: `${base}/details`,
    },
    { key: 'sections', ok: input.sections.length >= 1, message: 'At least one section', fixPath: `${base}` },
    { key: 'lessons', ok: lessons.length >= 1, message: 'At least one lesson', fixPath: `${base}` },
    {
      key: 'lessonContent',
      ok: lessons.length >= 1 && notReady.length === 0,
      message:
        notReady.length === 0
          ? 'Every lesson has its content'
          : `Lessons without content: ${notReady
              .map((l) => `"${l.title}"`)
              .slice(0, 3)
              .join(', ')}${notReady.length > 3 ? ` and ${notReady.length - 3} more` : ''}`,
      fixPath: `${base}`,
    },
  ];
  if (input.priceMinor > 0) {
    items.push({
      key: 'price',
      ok: input.priceMinor >= input.minPaidPriceMinor,
      message: 'A price of 0 (free) or at least the minimum price',
      fixPath: `${base}/pricing`,
    });
    items.push({
      key: 'payments',
      ok: input.paymentsAvailable,
      message: 'Paid courses need the school’s payment account and your payout method (available soon)',
      fixPath: `${base}/pricing`,
    });
  }
  return items;
}
