import { requireTenantId, type TenantTx } from '../../platform';
import { courseProgress } from '../domain/progress-rules';

/**
 * BR-22: a quiz lesson is complete when its quiz is passed (or, without a pass mark, graded). Called by
 * the assessment module inside the transaction that grades the attempt. Marks every lesson of the course
 * that uses the quiz, then recomputes the enrolment's progress and completion. Does nothing without an
 * active enrolment.
 */
export async function recordQuizPassed(
  tx: TenantTx,
  input: { membershipId: string; courseId: string; quizId: string },
): Promise<void> {
  const enrollment = await tx.enrollment.findFirst({
    where: { membershipId: input.membershipId, courseId: input.courseId, status: 'ACTIVE' },
    select: { id: true, completedAt: true },
  });
  if (enrollment === null) return;
  await tx.$queryRaw`SELECT id FROM enrollment WHERE id = ${enrollment.id}::uuid FOR UPDATE`;
  const quizLessons = await tx.lesson.findMany({
    where: { courseId: input.courseId, quizId: input.quizId },
    select: { id: true },
  });
  if (quizLessons.length === 0) return;
  const tenantId = requireTenantId();
  const now = new Date();
  for (const lesson of quizLessons) {
    const key = { tenantId, enrollmentId: enrollment.id, lessonId: lesson.id };
    const existing = await tx.lessonProgress.findUnique({
      where: { tenantId_enrollmentId_lessonId: key },
      select: { completedAt: true },
    });
    await tx.lessonProgress.upsert({
      where: { tenantId_enrollmentId_lessonId: key },
      create: { ...key, status: 'COMPLETED', completedAt: now, updatedAt: now },
      update: { status: 'COMPLETED', completedAt: existing?.completedAt ?? now, updatedAt: now },
    });
  }
  const lessons = await tx.lesson.findMany({
    where: { courseId: input.courseId },
    select: { id: true, isRequired: true },
  });
  const done = await tx.lessonProgress.findMany({
    where: { enrollmentId: enrollment.id, status: 'COMPLETED' },
    select: { lessonId: true },
  });
  const summary = courseProgress(lessons, new Set(done.map((d) => d.lessonId)));
  const [locked] = await tx.$queryRaw<{ completed_at: Date | null }[]>`
    SELECT completed_at FROM enrollment WHERE id = ${enrollment.id}::uuid`;
  await tx.enrollment.update({
    where: { id: enrollment.id },
    data: {
      progressPercent: summary.percent,
      updatedAt: now,
      ...(summary.complete && (locked?.completed_at ?? null) === null && { completedAt: now }),
    },
  });
}
