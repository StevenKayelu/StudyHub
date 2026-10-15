import { Injectable } from '@nestjs/common';
import type { GradingQueue, QuizAnalytics, StudioAttemptList } from '@studyhub/contracts';

import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit';
import type { TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb } from '../../platform';
import { requireFeature } from '../../tenancy';
import type { AnswerResponse, QuestionSnapshot } from '../domain/scoring';
import { num, ownCourse, ownCourseOf } from './access';
import { completeManualGrading } from './grading-core';

const nameOf = (m: { displayNameOverride: string | null; user: { displayName: string } }) =>
  m.displayNameOverride ?? m.user.displayName;

const MEMBER_NAME = {
  select: { displayNameOverride: true, user: { select: { displayName: true } } },
} as const;

/** Median of a sorted-or-not list (null when empty), rounded to 2 dp. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return Math.round(value * 100) / 100;
}

/**
 * Studio results (S-T10): assessed attempts (practice never appears here, F22 AC 2), the manual grading
 * queue for long answers (F20), and quiz analytics (F23, `quizAnalytics` feature).
 */
@Injectable()
export class ResultsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async attempts(
    actor: TenantActor,
    courseId: string,
    query: { quizId?: string | undefined; status?: string | undefined },
  ): Promise<StudioAttemptList> {
    return this.db.run(async (tx) => {
      await ownCourse(tx, actor, courseId);
      const rows = await tx.attempt.findMany({
        where: {
          courseId,
          mode: 'ASSESSED',
          status: query.status === undefined ? { not: 'IN_PROGRESS' } : (query.status as 'GRADED'),
          ...(query.quizId !== undefined && { quizId: query.quizId }),
        },
        orderBy: { submittedAt: { sort: 'desc', nulls: 'last' } },
        take: 500,
        include: { quiz: { select: { title: true } }, membership: MEMBER_NAME },
      });
      return {
        items: rows.map((a) => ({
          id: a.id,
          quizId: a.quizId!,
          quizTitle: a.quiz?.title ?? '',
          learnerName: nameOf(a.membership),
          attemptNumber: a.attemptNumber ?? 0,
          status: a.status,
          submittedAt: a.submittedAt?.toISOString() ?? null,
          percent: a.percent === null ? null : num(a.percent),
          passed: a.passed,
        })),
      };
    });
  }

  /** Long answers waiting for marks, oldest submission first (F20). */
  async queue(actor: TenantActor, courseId: string): Promise<GradingQueue> {
    return this.db.run(async (tx) => {
      await ownCourse(tx, actor, courseId);
      const items = await tx.attemptItem.findMany({
        where: {
          attempt: { courseId, mode: 'ASSESSED', status: 'NEEDS_REVIEW' },
          answer: { is: { awardedPoints: null } },
        },
        include: {
          answer: true,
          attempt: { include: { quiz: { select: { title: true } }, membership: MEMBER_NAME } },
        },
        orderBy: [{ attempt: { submittedAt: 'asc' } }, { position: 'asc' }],
        take: 200,
      });
      return {
        items: items.map((item) => {
          const response = item.answer!.response as AnswerResponse;
          return {
            attemptId: item.attemptId,
            itemId: item.id,
            quizTitle: item.attempt.quiz?.title ?? '',
            learnerName: nameOf(item.attempt.membership),
            position: item.position,
            points: num(item.points),
            stem: (item.questionSnapshot as unknown as QuestionSnapshot).stem,
            response: 'text' in response ? response.text : '',
            submittedAt: item.attempt.submittedAt?.toISOString() ?? null,
          };
        }),
      };
    });
  }

  /** Scores one long answer; the last one completes the attempt (GRADED, totals from per-answer points). */
  async grade(
    actor: TenantActor,
    attemptId: string,
    itemId: string,
    input: { points: number; comment?: string | undefined },
  ): Promise<{ attemptStatus: string }> {
    return this.db.run(async (tx) => {
      const attempt = await tx.attempt.findUnique({
        where: { id: attemptId },
        select: { courseId: true, status: true },
      });
      await ownCourseOf(tx, actor, attempt?.courseId);
      if (attempt!.status !== 'NEEDS_REVIEW')
        throw new AppError('INVALID_STATE', { detail: 'This attempt isn’t waiting for marks.' });
      const item = await tx.attemptItem.findFirst({
        where: { id: itemId, attemptId },
        include: { answer: true },
      });
      if (item === null || item.answer === null) throw new AppError('NOT_FOUND');
      if ((item.questionSnapshot as unknown as QuestionSnapshot).type !== 'LONG_ANSWER') {
        throw new AppError('INVALID_STATE', { detail: 'Only long answers are marked by hand.' });
      }
      const max = num(item.points);
      if (input.points > max) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'points', code: 'too_high', message: `At most ${max} points` }],
        });
      }
      await tx.attemptAnswer.update({
        where: { tenantId_attemptItemId: { tenantId: requireTenantId(), attemptItemId: itemId } },
        data: {
          awardedPoints: new Prisma.Decimal(input.points),
          isCorrect: input.points >= max,
          graderComment: input.comment === undefined || input.comment === '' ? null : input.comment,
          gradedBy: actor.membershipId,
          gradedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        action: 'attempt.item_graded',
        entityType: 'attempt',
        entityId: attemptId,
        actorId: actor.userId,
        after: { itemId, points: input.points },
      });
      const done = await completeManualGrading(tx, attemptId, actor.membershipId);
      return { attemptStatus: done ? 'GRADED' : 'NEEDS_REVIEW' };
    });
  }

  /** F23: graded assessed attempts of one quiz, summarised per quiz and per question. */
  async analytics(actor: TenantActor, quizId: string): Promise<QuizAnalytics> {
    return this.db.run(async (tx) => {
      const quiz = await tx.quiz.findUnique({ where: { id: quizId }, select: { courseId: true } });
      await ownCourseOf(tx, actor, quiz?.courseId);
      await requireFeature(tx, 'quizAnalytics');
      const attempts = await tx.attempt.findMany({
        where: { quizId, mode: 'ASSESSED', status: 'GRADED' },
        select: { id: true, percent: true, passed: true },
      });
      const percents = attempts.map((a) => num(a.percent));
      const withVerdict = attempts.filter((a) => a.passed !== null);
      const distribution = Array.from({ length: 10 }, () => 0);
      for (const p of percents) distribution[Math.min(9, Math.floor(p / 10))]! += 1;
      const items = await tx.attemptItem.findMany({
        where: { attemptId: { in: attempts.map((a) => a.id) } },
        include: { answer: true },
        orderBy: { position: 'asc' },
      });
      const byQuestion = new Map<string, typeof items>();
      for (const item of items)
        byQuestion.set(item.questionId, [...(byQuestion.get(item.questionId) ?? []), item]);
      const questions = await tx.question.findMany({
        where: { id: { in: [...byQuestion.keys()] } },
        include: { options: { orderBy: { position: 'asc' } } },
      });
      return {
        quizId,
        attempts: attempts.length,
        averagePercent:
          percents.length === 0
            ? null
            : Math.round((percents.reduce((s, p) => s + p, 0) / percents.length) * 100) / 100,
        medianPercent: median(percents),
        passRate:
          withVerdict.length === 0
            ? null
            : Math.round((withVerdict.filter((a) => a.passed).length / withVerdict.length) * 10_000) / 100,
        distribution,
        questions: questions.map((question) => {
          const rows = byQuestion.get(question.id) ?? [];
          const answered = rows.filter((r) => r.answer !== null);
          const gradable = answered.filter((r) => r.answer!.isCorrect !== null);
          const picks = new Map<string, number>();
          for (const row of answered) {
            const response = row.answer!.response as AnswerResponse;
            if ('optionIds' in response)
              for (const id of response.optionIds) picks.set(id, (picks.get(id) ?? 0) + 1);
          }
          return {
            questionId: question.id,
            stemText: question.stemText,
            type: question.type,
            answered: answered.length,
            correctRate:
              gradable.length === 0
                ? null
                : Math.round(
                    (gradable.filter((r) => r.answer!.isCorrect).length / gradable.length) * 10_000,
                  ) / 100,
            options: question.options.map((o) => ({
              id: o.id,
              content: typeof o.contentJson === 'string' ? o.contentJson : '',
              isCorrect: o.isCorrect,
              picks: picks.get(o.id) ?? 0,
            })),
          };
        }),
      };
    });
  }
}
