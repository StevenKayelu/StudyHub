import { can, type TenantActor } from '../../identity';
import { AppError, type TenantTx } from '../../platform';

/**
 * The actor's own course, for Studio's question bank, quizzes, results and grading (05 §4.4 "T owner").
 * Another instructor's course, or another school's (RLS), is not found; a member who owns the course but
 * has lost the instructor role is forbidden.
 */
export async function ownCourse(tx: TenantTx, actor: TenantActor, courseId: string) {
  const course = await tx.course.findUnique({
    where: { id: courseId },
    select: { id: true, title: true, ownerMembershipId: true, status: true },
  });
  if (course === null || course.ownerMembershipId !== actor.membershipId) throw new AppError('NOT_FOUND');
  if (!can(actor, 'studio.access')) throw new AppError('FORBIDDEN');
  return course;
}

/** The course of a question/quiz the actor owns (same rules as ownCourse). */
export async function ownCourseOf(tx: TenantTx, actor: TenantActor, courseId: string | undefined) {
  if (courseId === undefined) throw new AppError('NOT_FOUND');
  return ownCourse(tx, actor, courseId);
}

/** Staff of a course: its owner (with Studio) or a school administrator (F21 tutor view, 05 §4.7). */
export function isCourseStaff(actor: TenantActor, course: { ownerMembershipId: string }): boolean {
  return (
    (course.ownerMembershipId === actor.membershipId && can(actor, 'studio.access')) ||
    can(actor, 'admin.access')
  );
}

export function requireActor(actor: TenantActor | null): TenantActor {
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

/** Decimal columns as numbers (2 dp; points never exceed 1000 per item). */
export const num = (value: { toString(): string } | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value.toString());
