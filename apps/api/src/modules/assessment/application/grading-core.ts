import type { Logger } from 'pino';

import type { PrismaClient } from '../../../generated/prisma/client';
import { Prisma } from '../../../generated/prisma/client';
import { recordQuizPassed } from '../../learning';
import { type JobEnvelope, requireTenantId, runInTenantTx, type TenantTx } from '../../platform';
import { overdue } from '../domain/quiz-rules';
import { type AnswerResponse, attemptTotals, type QuestionSnapshot, scoreAnswer } from '../domain/scoring';
import { num } from './access';

/** Queue for submitting an attempt at its deadline (F19 AC 3); fed by the outbox when an attempt starts. */
export const AUTO_SUBMIT_JOB = 'assessment.auto-submit';

/** Locks the attempt row for this transaction (one finaliser at a time, F19 AC 5 / M7 AC 3). */
export async function lockAttempt(tx: TenantTx, attemptId: string) {
  const [row] = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM attempt WHERE id = ${attemptId}::uuid FOR UPDATE`;
  if (row === undefined) return null;
  return tx.attempt.findUniqueOrThrow({ where: { id: attemptId } });
}

/**
 * Grades an attempt in progress (manual submit, auto-submit or a late visit): every answer is scored
 * against its snapshot (BR-19, BR-21), then the attempt becomes GRADED, or NEEDS_REVIEW when a long
 * answer waits for the tutor (F20). Idempotent: an attempt no longer in progress is left alone.
 * `onlyIfOverdue` (the auto-submit job) leaves an attempt alone until its deadline and grace have passed.
 */
export async function finalizeAttempt(
  tx: TenantTx,
  attemptId: string,
  kind: 'MANUAL' | 'AUTO',
  options: { now?: Date; onlyIfOverdue?: boolean } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const attempt = await lockAttempt(tx, attemptId);
  if (attempt === null || attempt.status !== 'IN_PROGRESS' || attempt.mode !== 'ASSESSED') return false;
  if (options.onlyIfOverdue === true && !overdue(attempt.deadlineAt, now)) return false;
  const items = await tx.attemptItem.findMany({
    where: { attemptId },
    include: { answer: true },
    orderBy: { position: 'asc' },
  });
  const tenantId = requireTenantId();
  let needsReview = false;
  const scored: { points: number; awarded: number }[] = [];
  for (const item of items) {
    const snapshot = item.questionSnapshot as unknown as QuestionSnapshot;
    const response = (item.answer?.response ?? null) as AnswerResponse | null;
    const score = scoreAnswer(snapshot, num(item.points), response);
    if (score.needsManual) needsReview = true;
    scored.push({ points: num(item.points), awarded: score.awarded });
    if (item.answer !== null) {
      await tx.attemptAnswer.update({
        where: { tenantId_attemptItemId: { tenantId, attemptItemId: item.id } },
        data: {
          isCorrect: score.isCorrect,
          awardedPoints: score.needsManual ? null : new Prisma.Decimal(score.awarded),
        },
      });
    }
  }
  const settings = attempt.settingsSnapshot as { passMarkPercent?: number | null };
  const totals = attemptTotals(scored, settings.passMarkPercent ?? null);
  await tx.attempt.update({
    where: { id: attemptId },
    data: {
      status: needsReview ? 'NEEDS_REVIEW' : 'GRADED',
      submittedAt: now,
      submitKind: kind,
      score: new Prisma.Decimal(totals.score),
      maxScore: new Prisma.Decimal(totals.maxScore),
      percent: new Prisma.Decimal(totals.percent),
      passed: needsReview ? null : totals.passed,
      ...(!needsReview && { gradedAt: now }),
      updatedAt: now,
    },
  });
  if (!needsReview && totals.passed !== false && attempt.quizId !== null) {
    await recordQuizPassed(tx, {
      membershipId: attempt.membershipId,
      courseId: attempt.courseId,
      quizId: attempt.quizId,
    });
  }
  return true;
}

/**
 * After a tutor scores a long answer: once every manual item has points, the attempt's totals are
 * recomputed from the per-answer points (F20 AC 1) and it becomes GRADED.
 */
export async function completeManualGrading(
  tx: TenantTx,
  attemptId: string,
  graderMembershipId: string,
): Promise<boolean> {
  const attempt = await lockAttempt(tx, attemptId);
  if (attempt === null || attempt.status !== 'NEEDS_REVIEW') return false;
  const items = await tx.attemptItem.findMany({ where: { attemptId }, include: { answer: true } });
  const pending = items.some((i) => i.answer !== null && i.answer.awardedPoints === null);
  if (pending) return false;
  const settings = attempt.settingsSnapshot as { passMarkPercent?: number | null };
  const totals = attemptTotals(
    items.map((i) => ({ points: num(i.points), awarded: num(i.answer?.awardedPoints ?? 0) })),
    settings.passMarkPercent ?? null,
  );
  const now = new Date();
  await tx.attempt.update({
    where: { id: attemptId },
    data: {
      status: 'GRADED',
      score: new Prisma.Decimal(totals.score),
      maxScore: new Prisma.Decimal(totals.maxScore),
      percent: new Prisma.Decimal(totals.percent),
      passed: totals.passed,
      gradedAt: now,
      gradedBy: graderMembershipId,
      updatedAt: now,
    },
  });
  if (totals.passed !== false && attempt.quizId !== null) {
    await recordQuizPassed(tx, {
      membershipId: attempt.membershipId,
      courseId: attempt.courseId,
      quizId: attempt.quizId,
    });
  }
  return true;
}

/**
 * Worker handler for AUTO_SUBMIT_JOB. The worker runs it inside the envelope's school context (threat
 * T12), so the attempt is found only in its own school: a job naming another school's attempt finds
 * nothing and does nothing (07 M7 AC 4).
 */
export function createAutoSubmitHandler(deps: { prisma: PrismaClient }) {
  return async (envelope: JobEnvelope, logger: Logger): Promise<void> => {
    const attemptId = envelope.payload.attemptId;
    if (typeof attemptId !== 'string') return;
    const submitted = await runInTenantTx(deps.prisma, (tx) =>
      finalizeAttempt(tx, attemptId, 'AUTO', { onlyIfOverdue: true }),
    );
    if (submitted) logger.info({ attemptId }, 'Attempt auto-submitted at its deadline');
  };
}
