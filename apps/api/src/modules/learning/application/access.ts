import type { LearnAccess } from '@studyhub/contracts';

import { can, type TenantActor } from '../../identity';
import { AppError, isSchoolReadOnly, type TenantTx } from '../../platform';
import { readContentSettings } from '../../tenancy';

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
}

export type Grant = { access: Exclude<LearnAccess, 'PREVIEW'>; enrollment: EnrollmentRow | null };

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
    select: { id: true, expiresAt: true, progressPercent: true, completedAt: true, lastLessonId: true },
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
    if (enrollment !== null) return { access: 'ENROLLED', enrollment };
  }
  if (course.ownerMembershipId === actor.membershipId) return { access: 'OWNER', enrollment: null };
  if (can(actor, 'admin.access')) return { access: 'ADMIN', enrollment: null };
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
    if (settings.catalogVisibility === 'MEMBERS_ONLY') throw new AppError('UNAUTHENTICATED');
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
