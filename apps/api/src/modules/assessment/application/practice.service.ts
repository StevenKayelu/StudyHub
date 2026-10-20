import { Injectable } from '@nestjs/common';
import type {
  AttemptView,
  PracticeFeedback,
  PracticeSetup,
  PracticeSummary,
  practiceStartSchema,
} from '@studyhub/contracts';
import type { z } from 'zod';

import { Prisma } from '../../../generated/prisma/client';
import type { TenantActor } from '../../identity';
import { grantFor, requireFullAccess } from '../../learning';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import { readContentSettings, requireFeature } from '../../tenancy';
import { shuffled } from '../domain/quiz-rules';
import {
  type AnswerResponse,
  attemptTotals,
  correctAnswer,
  type QuestionSnapshot,
  responseFits,
  scoreAnswer,
} from '../domain/scoring';
import { num, requireActor } from './access';
import { AttemptsService, type SettingsSnapshot, snapshotOf } from './attempts.service';

type PracticeStart = z.output<typeof practiceStartSchema>;

const MISTAKE_DAYS = 30;

/** Auto-gradable, practice-eligible, active questions of a course (F22; never long answers, AC 3). */
const practicePool = (courseId: string): Prisma.QuestionWhereInput => ({
  courseId,
  status: 'ACTIVE',
  practiceEligible: true,
  type: { not: 'LONG_ANSWER' },
});

/**
 * Practice (F22, S-L07): untimed sets drawn from a course's bank with immediate feedback. Only for
 * enrolled learners (AC 1), never in gradebooks or completion (AC 2), and only while the school has the
 * `practiceMode` feature (F40: FEATURE_NOT_ENABLED otherwise; past practice is kept).
 */
@Injectable()
export class PracticeService {
  constructor(
    private readonly db: TenantDb,
    private readonly attempts: AttemptsService,
  ) {}

  async setup(actor: TenantActor | null, courseId: string): Promise<PracticeSetup> {
    const member = requireActor(actor);
    return this.db.run(async (tx) => {
      await requireFeature(tx, 'practiceMode');
      const course = await this.enrolledCourse(tx, member, courseId);
      const pool = await tx.question.findMany({ where: practicePool(courseId), select: { tags: true } });
      const { practiceDefaults } = await readContentSettings(tx);
      const mistakes = practiceDefaults.mistakesModeEnabled ? await this.mistakes(tx, member, courseId) : [];
      return {
        courseId,
        courseTitle: course.title,
        available: pool.length,
        tags: [...new Set(pool.flatMap((q) => q.tags))].sort(),
        defaultCount: practiceDefaults.questionsPerSession,
        mistakesModeEnabled: practiceDefaults.mistakesModeEnabled,
        mistakesAvailable: mistakes.length,
      };
    });
  }

  async start(actor: TenantActor | null, courseId: string, input: PracticeStart): Promise<AttemptView> {
    const member = requireActor(actor);
    const attemptId = await this.db.run(async (tx) => {
      await requireFeature(tx, 'practiceMode');
      await this.enrolledCourse(tx, member, courseId);
      const { practiceDefaults } = await readContentSettings(tx);
      if (input.mistakesOnly && !practiceDefaults.mistakesModeEnabled)
        throw new AppError('FEATURE_NOT_ENABLED');
      const ids = input.mistakesOnly ? await this.mistakes(tx, member, courseId) : null;
      const candidates = await tx.question.findMany({
        where: {
          ...practicePool(courseId),
          ...(ids !== null && { id: { in: ids } }),
          ...(input.tags.length > 0 && { tags: { hasSome: input.tags } }),
          ...(input.difficulty !== undefined && { difficulty: input.difficulty }),
        },
        include: { options: { orderBy: { position: 'asc' } } },
      });
      const picked = shuffled(candidates).slice(0, input.count ?? practiceDefaults.questionsPerSession);
      if (picked.length === 0) {
        throw new AppError('INVALID_STATE', { detail: 'No practice questions match these choices yet.' });
      }
      const tenantId = requireTenantId();
      const settings: SettingsSnapshot = {
        title: 'Practice',
        feedbackPolicy: 'IMMEDIATE',
        showCorrectAnswers: true,
        passMarkPercent: null,
        closesAt: null,
        attemptsAllowed: null,
      };
      const attempt = await tx.attempt.create({
        data: {
          tenantId,
          membershipId: member.membershipId,
          courseId,
          mode: 'PRACTICE',
          settingsSnapshot: { ...settings, filters: input } as object,
        },
        select: { id: true },
      });
      for (const [position, question] of picked.entries()) {
        await tx.attemptItem.create({
          data: {
            tenantId,
            attemptId: attempt.id,
            position,
            questionId: question.id,
            questionSnapshot: snapshotOf(question, true) as object,
            points: question.points,
          },
        });
      }
      return attempt.id;
    });
    return this.attempts.view(member, attemptId);
  }

  /** "Check": the answer is graded at once and the correct answer and explanation come back. */
  async answer(
    actor: TenantActor | null,
    attemptId: string,
    itemId: string,
    response: AnswerResponse,
  ): Promise<PracticeFeedback> {
    const member = requireActor(actor);
    return this.db.run(async (tx) => {
      await requireFeature(tx, 'practiceMode');
      await this.ownPractice(tx, member, attemptId, true);
      const item = await tx.attemptItem.findFirst({
        where: { id: itemId, attemptId },
        include: { answer: true },
      });
      if (item === null) throw new AppError('NOT_FOUND');
      const snapshot = item.questionSnapshot as unknown as QuestionSnapshot;
      const feedback = (isCorrect: boolean, awarded: number): PracticeFeedback => ({
        isCorrect,
        awardedPoints: awarded,
        correct: correctAnswer(snapshot),
        explanation: snapshot.explanation ?? null,
      });
      // Checked once: the first answer counts (and feeds "my mistakes").
      if (item.answer !== null && item.answer.isCorrect !== null)
        return feedback(item.answer.isCorrect, num(item.answer.awardedPoints));
      if (!responseFits(snapshot, response)) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'response', code: 'shape', message: 'This answer doesn’t fit the question' }],
        });
      }
      const score = scoreAnswer(snapshot, num(item.points), response);
      const isCorrect = score.isCorrect === true;
      await tx.attemptAnswer.upsert({
        where: { tenantId_attemptItemId: { tenantId: requireTenantId(), attemptItemId: itemId } },
        create: {
          tenantId: requireTenantId(),
          attemptItemId: itemId,
          response: response as object,
          isCorrect,
          awardedPoints: new Prisma.Decimal(score.awarded),
        },
        update: {
          response: response as object,
          isCorrect,
          awardedPoints: new Prisma.Decimal(score.awarded),
          savedAt: new Date(),
        },
      });
      await tx.attempt.update({ where: { id: attemptId }, data: { updatedAt: new Date() } });
      return feedback(isCorrect, score.awarded);
    });
  }

  /** The summary: score over the questions answered, and the weakest tags to practise again. */
  async finish(actor: TenantActor | null, attemptId: string): Promise<PracticeSummary> {
    const member = requireActor(actor);
    return this.db.run(async (tx) => {
      await requireFeature(tx, 'practiceMode');
      const attempt = await this.ownPractice(tx, member, attemptId, false);
      const items = await tx.attemptItem.findMany({ where: { attemptId }, include: { answer: true } });
      const answered = items.filter((i) => i.answer !== null && i.answer.isCorrect !== null);
      const totals = attemptTotals(
        answered.map((i) => ({ points: num(i.points), awarded: num(i.answer!.awardedPoints) })),
        null,
      );
      if (attempt.status === 'IN_PROGRESS') {
        const now = new Date();
        await tx.attempt.update({
          where: { id: attemptId },
          data: {
            status: 'GRADED',
            submittedAt: now,
            submitKind: 'MANUAL',
            gradedAt: now,
            score: new Prisma.Decimal(totals.score),
            maxScore: new Prisma.Decimal(totals.maxScore),
            percent: new Prisma.Decimal(totals.percent),
            updatedAt: now,
          },
        });
      }
      const byTag = new Map<string, { correct: number; total: number }>();
      for (const item of answered) {
        for (const tag of (item.questionSnapshot as unknown as QuestionSnapshot).tags) {
          const entry = byTag.get(tag) ?? { correct: 0, total: 0 };
          entry.total += 1;
          if (item.answer!.isCorrect === true) entry.correct += 1;
          byTag.set(tag, entry);
        }
      }
      const weakTags = [...byTag.entries()]
        .filter(([, v]) => v.correct < v.total)
        .map(([tag, v]) => ({ tag, ...v }))
        .sort((a, b) => a.correct / a.total - b.correct / b.total || b.total - a.total)
        .slice(0, 3);
      return {
        attemptId,
        courseId: attempt.courseId,
        answered: answered.length,
        total: items.length,
        score: totals.score,
        maxScore: totals.maxScore,
        percent: totals.percent,
        weakTags,
      };
    });
  }

  // ----------------------------------------------------------------------------------------------

  /** F22 AC 1: practice is for enrolled learners only. */
  private async enrolledCourse(tx: TenantTx, actor: TenantActor, courseId: string) {
    const course = await tx.course.findUnique({
      where: { id: courseId },
      select: { id: true, title: true, status: true, ownerMembershipId: true, firstPublishedAt: true },
    });
    if (course === null) throw new AppError('NOT_FOUND');
    const grant = await grantFor(tx, actor, course);
    if (grant?.access !== 'ENROLLED') {
      throw new AppError(
        course.status === 'PUBLISHED' || grant !== null ? 'ENROLMENT_INACTIVE' : 'NOT_FOUND',
      );
    }
    requireFullAccess(grant, course.id);
    return course;
  }

  private async ownPractice(tx: TenantTx, actor: TenantActor, attemptId: string, mustBeOpen: boolean) {
    const attempt = await tx.attempt.findUnique({ where: { id: attemptId } });
    if (attempt === null || attempt.membershipId !== actor.membershipId || attempt.mode !== 'PRACTICE') {
      throw new AppError('NOT_FOUND');
    }
    if (mustBeOpen && attempt.status !== 'IN_PROGRESS') throw new AppError('ATTEMPT_CLOSED');
    return attempt;
  }

  /** "Review my mistakes" (F22 SHOULD): questions this learner answered wrong in the last 30 days. */
  private async mistakes(tx: TenantTx, actor: TenantActor, courseId: string): Promise<string[]> {
    const rows = await tx.$queryRaw<{ question_id: string }[]>`
      SELECT DISTINCT i.question_id
        FROM attempt_answer a
        JOIN attempt_item i ON i.id = a.attempt_item_id
        JOIN attempt t ON t.id = i.attempt_id
        JOIN question q ON q.id = i.question_id
       WHERE t.membership_id = ${actor.membershipId}::uuid
         AND t.course_id = ${courseId}::uuid
         AND a.is_correct = false
         AND a.saved_at > now() - make_interval(days => ${MISTAKE_DAYS})
         AND q.status = 'ACTIVE' AND q.practice_eligible AND q.type <> 'LONG_ANSWER'
       LIMIT 500`;
    return rows.map((r) => r.question_id);
  }
}
