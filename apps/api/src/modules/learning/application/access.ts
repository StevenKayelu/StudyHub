import type { LearnAccess } from '@studyhub/contracts';

import { can, type TenantActor } from '../../identity';
import { AppError, isSchoolReadOnly, type TenantTx } from '../../platform';
import { readContentSettings, readFeatures } from '../../tenancy';
import { lockedLessonIds } from '../domain/deposit-access';
import { type CourseLock, courseLock } from '../domain/period-access';

/** The course fields every access decision needs. */
export interface CourseForAccess {
  id: string;
  status: string;
  ownerMembershipId: string;
  firstPublishedAt: Date | null;
}

export interface EnrollmentRow {
  id: string;
  expiresAt: Date | null;
  progressPercent: number;
  completedAt: Date | null;
  lastLessonId: string | null;
  /** Deposit plan: the share of lessons open while the balance is unpaid (null = everything). */
  accessLimitPct: number | null;
  balanceMinor: bigint | null;
  balanceDueAt: Date | null;
}

const ENROLLMENT_FIELDS = {
  id: true,
  expiresAt: true,
  progressPercent: true,
  completedAt: true,
  lastLessonId: true,
  accessLimitPct: true,
  balanceMinor: true,
  balanceDueAt: true,
} as const;

/** `lock`: the course's period (or an administrator) keeps an enrolled learner out for now. */
export type Grant = {
  access: Exclude<LearnAccess, 'PREVIEW'>;
  enrollment: EnrollmentRow | null;
  lock: CourseLock | null;
};

/** Whether the course is open now (docs/design/course-periods.md); null when it is. */
export async function readCourseLock(
  tx: TenantTx,
  courseId: string,
  now = new Date(),
): Promise<CourseLock | null> {
  const course = await tx.course.findUnique({
    where: { id: courseId },
    select: { accessOverride: true, period: { select: { name: true, startsAt: true, mode: true } } },
  });
  if (course === null) return null;
  return courseLock(course.period, course.accessOverride, now);
}

/** A lock as the API shows it. */
export function lockView(lock: CourseLock | null) {
  return lock === null ? null : { periodName: lock.periodName, opensAt: lock.opensAt?.toISOString() ?? null };
}

/** The refusal for content of a course whose period hasn't opened (403, course-periods.md decision 8). */
export function courseNotOpen(lock: CourseLock, courseId: string): AppError {
  return new AppError('COURSE_NOT_OPEN', {
    detail:
      lock.opensAt === null
        ? 'This course is not open yet. Your school will open it.'
        : 'This course opens at the start of its term.',
    extensions: { courseId, periodName: lock.periodName, opensAt: lock.opensAt?.toISOString() ?? null },
  });
}

/**
 * The actor's ACTIVE, unexpired enrolment in a course, or null. Evaluated on every request, so a
 * revocation or expiry takes effect on the next one (F14 AC 2, BR-12). An enrolment found past its
 * expiry is marked EXPIRED here (not while the school is read-only, BR-52).
 */
export async function activeEnrollment(
  tx: TenantTx,
  membershipId: string,
  courseId: string,
  expired?: string[],
): Promise<EnrollmentRow | null> {
  const enrollment = await tx.enrollment.findFirst({
    where: { membershipId, courseId, status: 'ACTIVE' },
    select: ENROLLMENT_FIELDS,
  });
  if (enrollment === null) return null;
  if (enrollment.expiresAt !== null && enrollment.expiresAt <= new Date()) {
    // Also reported to the caller: if its transaction ends in a refusal, it records the expiry anew.
    expired?.push(enrollment.id);
    if (!isSchoolReadOnly()) {
      await tx.enrollment.update({
        where: { id: enrollment.id },
        data: { status: 'EXPIRED', updatedAt: new Date() },
      });
    }
    return null;
  }
  return enrollment;
}

/**
 * How the actor reaches a course's content, or null (2. in the M6 design note):
 * - an enrolled learner, while the course has ever been published (unpublishing or archiving it, or
 *   suspending its instructor, doesn't take away what learners have);
 * - the course owner and school administrators, without enrolling (F14 AC 3).
 */
export async function grantFor(
  tx: TenantTx,
  actor: TenantActor | null,
  course: CourseForAccess,
  expired?: string[],
): Promise<Grant | null> {
  if (actor === null) return null;
  if (course.firstPublishedAt !== null) {
    const enrollment = await activeEnrollment(tx, actor.membershipId, course.id, expired);
    if (enrollment !== null) {
      return { access: 'ENROLLED', enrollment, lock: await readCourseLock(tx, course.id) };
    }
  }
  if (course.ownerMembershipId === actor.membershipId)
    return { access: 'OWNER', enrollment: null, lock: null };
  if (can(actor, 'admin.access')) return { access: 'ADMIN', enrollment: null, lock: null };
  return null;
}

/**
 * Whether the course is in this school's catalogue for the actor: PUBLISHED, its instructor not
 * suspended (BR-28), and a members-only catalogue needs a signed-in member (BR-57: 401 otherwise).
 */
export async function inCatalogue(
  tx: TenantTx,
  actor: TenantActor | null,
  course: CourseForAccess,
): Promise<boolean> {
  if (course.status !== 'PUBLISHED') return false;
  if (actor === null) {
    const settings = await readContentSettings(tx);
    if (!(await readFeatures(tx)).publicCatalog || settings.catalogVisibility === 'MEMBERS_ONLY') {
      throw new AppError('UNAUTHENTICATED');
    }
  }
  const profile = await tx.instructorProfile.findUnique({
    where: { membershipId: course.ownerMembershipId },
    select: { status: true },
  });
  return profile?.status !== 'SUSPENDED';
}

/** The refusal for a course the actor can't open: locked (403/401) if it's in the catalogue, else 404. */
export async function refusal(
  tx: TenantTx,
  actor: TenantActor | null,
  course: CourseForAccess,
): Promise<AppError> {
  if (!(await inCatalogue(tx, actor, course))) return new AppError('NOT_FOUND');
  return actor === null ? new AppError('UNAUTHENTICATED') : new AppError('ENROLMENT_INACTIVE');
}

/** The course's lessons in reading order (sections by position, then lessons by position). */
async function readingOrder(tx: TenantTx, courseId: string) {
  const sections = await tx.section.findMany({
    where: { courseId },
    orderBy: { position: 'asc' },
    select: {
      lessons: { orderBy: { position: 'asc' }, select: { id: true, isPreview: true, quizId: true } },
    },
  });
  return sections.flatMap((section) => section.lessons);
}

/** The refusal for content beyond a deposit: what is owed and by when (402, docs/design/payment-plans.md). */
export function balanceRequired(enrollment: EnrollmentRow, courseId: string): AppError {
  return new AppError('BALANCE_REQUIRED', {
    detail: 'Your deposit opens part of this course. Pay the balance to open the rest.',
    extensions: {
      courseId,
      balanceMinor: Number(enrollment.balanceMinor ?? 0n),
      dueAt: enrollment.balanceDueAt?.toISOString() ?? null,
      lessonPct: enrollment.accessLimitPct,
    },
  });
}

/**
 * Lessons of the course an enrolled learner can't open yet: every lesson but the previews while the
 * course is not open, else those beyond a deposit. Empty for owners, administrators and full access.
 */
export async function lockedLessons(tx: TenantTx, grant: Grant, courseId: string): Promise<Set<string>> {
  if (grant.access !== 'ENROLLED') return new Set();
  const limit = grant.lock !== null ? 0 : (grant.enrollment?.accessLimitPct ?? null);
  if (limit === null) return new Set();
  return lockedLessonIds(await readingOrder(tx, courseId), limit);
}

/** The refusal for a locked lesson: the period first, then the deposit. */
export function lessonRefusal(grant: Grant, courseId: string): AppError {
  if (grant.lock !== null) return courseNotOpen(grant.lock, courseId);
  if (grant.enrollment !== null) return balanceRequired(grant.enrollment, courseId);
  return new AppError('ENROLMENT_INACTIVE');
}

/**
 * Refuses a quiz a deposit enrolment can't reach yet (PROPOSED 2): it must belong to an open lesson.
 * Full access, owners and administrators pass.
 */
export async function requireQuizOpen(
  tx: TenantTx,
  grant: Grant,
  courseId: string,
  quizId: string,
): Promise<void> {
  if (grant.access === 'ENROLLED' && grant.lock !== null) throw courseNotOpen(grant.lock, courseId);
  const enrollment = grant.enrollment;
  if (grant.access !== 'ENROLLED' || enrollment === null || enrollment.accessLimitPct === null) return;
  const lessons = await readingOrder(tx, courseId);
  const locked = lockedLessonIds(lessons, enrollment.accessLimitPct);
  const open = lessons.some((lesson) => lesson.quizId === quizId && !locked.has(lesson.id));
  if (!open) throw balanceRequired(enrollment, courseId);
}

/** Practice draws on the whole question bank, so it needs the full, open course (decision 2). */
export function requireFullAccess(grant: Grant, courseId: string): void {
  if (grant.access === 'ENROLLED' && grant.lock !== null) throw courseNotOpen(grant.lock, courseId);
  if (grant.access === 'ENROLLED' && grant.enrollment !== null && grant.enrollment.accessLimitPct !== null) {
    throw balanceRequired(grant.enrollment, courseId);
  }
}
