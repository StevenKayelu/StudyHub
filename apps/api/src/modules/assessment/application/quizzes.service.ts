import { Injectable } from '@nestjs/common';
import {
  type QuizList,
  type quizItemsSchema,
  type QuizView,
  sanitizeRichText,
  type updateQuizSchema,
} from '@studyhub/contracts';
import type { z } from 'zod';

import { Prisma } from '../../../generated/prisma/client';
import type { TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import { readContentSettings } from '../../tenancy';
import { quizProblems } from '../domain/quiz-rules';
import { num, ownCourse, ownCourseOf } from './access';

type QuizUpdate = z.output<typeof updateQuizSchema>;
type QuizItems = z.output<typeof quizItemsSchema>;

export interface DrawRuleRow {
  count: number;
  tags: string[];
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null;
  types: ('SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'NUMERIC' | 'LONG_ANSWER')[];
}

/** Active questions of a course matching a draw rule (any of its tags; its difficulty and types). */
export function drawWhere(courseId: string, rule: DrawRuleRow): Prisma.QuestionWhereInput {
  return {
    courseId,
    status: 'ACTIVE',
    ...(rule.tags.length > 0 && { tags: { hasSome: rule.tags } }),
    ...(rule.difficulty !== null && { difficulty: rule.difficulty }),
    ...(rule.types.length > 0 && { type: { in: rule.types } }),
  };
}

/**
 * Quiz builder (F18, S-T06): settings, a fixed question list or draw rules, and READY once the quiz
 * checklist passes (F18 AC 1). New quizzes start from the school's quiz defaults (BR-64).
 */
@Injectable()
export class QuizzesService {
  constructor(private readonly db: TenantDb) {}

  async list(actor: TenantActor, courseId: string): Promise<QuizList> {
    const ids = await this.db.run(async (tx) => {
      await ownCourse(tx, actor, courseId);
      return tx.quiz.findMany({ where: { courseId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    });
    const views = await Promise.all(ids.map((q) => this.get(actor, q.id)));
    return {
      items: views.map((v) => ({
        id: v.id,
        title: v.title,
        status: v.status,
        questionCount: v.questionCount,
        totalPoints: v.totalPoints,
        attemptCount: v.attemptCount,
        updatedAt: new Date().toISOString(),
      })),
    };
  }

  async create(actor: TenantActor, courseId: string, title: string): Promise<QuizView> {
    const id = await this.db.run(async (tx) => {
      await ownCourse(tx, actor, courseId);
      const { quizDefaults } = await readContentSettings(tx);
      const quiz = await tx.quiz.create({
        data: {
          tenantId: requireTenantId(),
          courseId,
          title,
          feedbackPolicy: quizDefaults.feedbackPolicy,
          attemptsAllowed: quizDefaults.attemptsAllowed,
          passMarkPercent: quizDefaults.passMarkPercent,
          shuffleQuestions: quizDefaults.shuffleQuestions,
          shuffleOptions: quizDefaults.shuffleOptions,
        },
        select: { id: true },
      });
      return quiz.id;
    });
    return this.get(actor, id);
  }

  async get(actor: TenantActor, quizId: string): Promise<QuizView> {
    return this.db.run(async (tx) => {
      const quiz = await tx.quiz.findUnique({ where: { id: quizId }, select: { courseId: true } });
      await ownCourseOf(tx, actor, quiz?.courseId);
      return this.view(tx, quizId);
    });
  }

  async update(actor: TenantActor, quizId: string, input: QuizUpdate): Promise<QuizView> {
    return this.db.run(async (tx) => {
      const quiz = await tx.quiz.findUnique({
        where: { id: quizId },
        select: { courseId: true, version: true, opensAt: true, closesAt: true, status: true },
      });
      await ownCourseOf(tx, actor, quiz?.courseId);
      if (quiz!.version !== input.version) throw new AppError('VERSION_CONFLICT');
      const opensAt =
        input.opensAt === undefined ? quiz!.opensAt : input.opensAt === null ? null : new Date(input.opensAt);
      const closesAt =
        input.closesAt === undefined
          ? quiz!.closesAt
          : input.closesAt === null
            ? null
            : new Date(input.closesAt);
      if (opensAt !== null && closesAt !== null && opensAt >= closesAt) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'closesAt', code: 'order', message: 'The quiz must open before it closes' }],
        });
      }
      await tx.quiz.update({
        where: { id: quizId },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.instructions !== undefined && {
            instructionsJson:
              input.instructions === null ? Prisma.DbNull : (sanitizeRichText(input.instructions) as object),
          }),
          ...(input.timeLimitMinutes !== undefined && {
            timeLimitSeconds: input.timeLimitMinutes === null ? null : input.timeLimitMinutes * 60,
          }),
          ...(input.attemptsAllowed !== undefined && { attemptsAllowed: input.attemptsAllowed }),
          ...(input.passMarkPercent !== undefined && { passMarkPercent: input.passMarkPercent }),
          ...(input.shuffleQuestions !== undefined && { shuffleQuestions: input.shuffleQuestions }),
          ...(input.shuffleOptions !== undefined && { shuffleOptions: input.shuffleOptions }),
          opensAt,
          closesAt,
          ...(input.feedbackPolicy !== undefined && { feedbackPolicy: input.feedbackPolicy }),
          ...(input.showCorrectAnswers !== undefined && { showCorrectAnswers: input.showCorrectAnswers }),
          ...(input.status !== undefined && { status: input.status }),
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      return this.checked(tx, quizId);
    });
  }

  /** Replaces the question list (FIXED) or the draw rules (DRAW). */
  async setItems(actor: TenantActor, quizId: string, input: QuizItems): Promise<QuizView> {
    return this.db.run(async (tx) => {
      const quiz = await tx.quiz.findUnique({
        where: { id: quizId },
        select: { courseId: true, version: true },
      });
      const course = await ownCourseOf(tx, actor, quiz?.courseId);
      if (quiz!.version !== input.version) throw new AppError('VERSION_CONFLICT');
      const tenantId = requireTenantId();
      await tx.quizItem.deleteMany({ where: { quizId } });
      await tx.quizDrawRule.deleteMany({ where: { quizId } });
      if (input.selectionMode === 'FIXED') {
        const ids = [...new Set(input.items.map((i) => i.questionId))];
        const found = await tx.question.findMany({
          where: { id: { in: ids }, courseId: course.id, status: 'ACTIVE' },
          select: { id: true },
        });
        if (found.length !== ids.length) {
          throw new AppError('VALIDATION_FAILED', {
            errors: [
              { field: 'items', code: 'unknown', message: 'Pick active questions from this course’s bank' },
            ],
          });
        }
        for (const [position, questionId] of ids.entries()) {
          const item = input.items.find((i) => i.questionId === questionId)!;
          await tx.quizItem.create({
            data: {
              tenantId,
              quizId,
              questionId,
              position,
              pointsOverride:
                item.pointsOverride === undefined || item.pointsOverride === null
                  ? null
                  : new Prisma.Decimal(item.pointsOverride),
            },
          });
        }
      } else {
        for (const [position, rule] of input.drawRules.entries()) {
          await tx.quizDrawRule.create({
            data: {
              tenantId,
              quizId,
              position,
              count: rule.count,
              tags: rule.tags,
              difficulty: rule.difficulty ?? null,
              types: rule.types,
            },
          });
        }
      }
      await tx.quiz.update({
        where: { id: quizId },
        data: { selectionMode: input.selectionMode, updatedAt: new Date(), version: { increment: 1 } },
      });
      return this.checked(tx, quizId);
    });
  }

  /** Only a quiz nobody has attempted can be deleted; its lessons lose the link. */
  async remove(actor: TenantActor, quizId: string): Promise<void> {
    await this.db.run(async (tx) => {
      const quiz = await tx.quiz.findUnique({ where: { id: quizId }, select: { courseId: true } });
      await ownCourseOf(tx, actor, quiz?.courseId);
      if ((await tx.attempt.count({ where: { quizId } })) > 0) {
        throw new AppError('INVALID_STATE', {
          detail: 'This quiz has attempts. Set it back to draft instead.',
        });
      }
      await tx.quiz.delete({ where: { id: quizId } });
    });
  }

  // ----------------------------------------------------------------------------------------------

  /** A READY quiz must stay valid: an edit that breaks the checklist is refused (and rolled back). */
  private async checked(tx: TenantTx, quizId: string): Promise<QuizView> {
    const view = await this.view(tx, quizId);
    if (view.status === 'READY' && view.problems.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The quiz isn’t ready yet.',
        errors: view.problems.map((p) => ({ field: p.field, code: 'not_ready', message: p.message })),
      });
    }
    return view;
  }

  async view(tx: TenantTx, quizId: string): Promise<QuizView> {
    const quiz = await tx.quiz.findUniqueOrThrow({
      where: { id: quizId },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: { question: { select: { type: true, stemText: true, points: true, status: true } } },
        },
        drawRules: { orderBy: { position: 'asc' } },
        _count: { select: { attempts: true } },
      },
    });
    const drawRules = await Promise.all(
      quiz.drawRules.map(async (rule) => {
        const matching = await tx.question.findMany({
          where: drawWhere(quiz.courseId, rule),
          select: { points: true },
        });
        const average =
          matching.length === 0 ? 0 : matching.reduce((s, q) => s + num(q.points), 0) / matching.length;
        return {
          count: rule.count,
          tags: rule.tags,
          difficulty: rule.difficulty,
          types: rule.types,
          available: matching.length,
          average,
        };
      }),
    );
    const activeItems = quiz.items.filter((i) => i.question.status === 'ACTIVE');
    const fixed = quiz.selectionMode === 'FIXED';
    const totalPoints = fixed
      ? activeItems.reduce((s, i) => s + num(i.pointsOverride ?? i.question.points), 0)
      : drawRules.reduce((s, r) => s + r.count * r.average, 0);
    const problems = quizProblems({
      selectionMode: quiz.selectionMode,
      itemCount: activeItems.length,
      drawRules,
      feedbackPolicy: quiz.feedbackPolicy,
      closesAt: quiz.closesAt,
    });
    return {
      id: quiz.id,
      courseId: quiz.courseId,
      title: quiz.title,
      instructions: quiz.instructionsJson ?? null,
      selectionMode: quiz.selectionMode,
      timeLimitMinutes: quiz.timeLimitSeconds === null ? null : Math.round(quiz.timeLimitSeconds / 60),
      attemptsAllowed: quiz.attemptsAllowed,
      passMarkPercent: quiz.passMarkPercent,
      shuffleQuestions: quiz.shuffleQuestions,
      shuffleOptions: quiz.shuffleOptions,
      opensAt: quiz.opensAt?.toISOString() ?? null,
      closesAt: quiz.closesAt?.toISOString() ?? null,
      feedbackPolicy: quiz.feedbackPolicy,
      showCorrectAnswers: quiz.showCorrectAnswers,
      status: quiz.status,
      version: quiz.version,
      items: quiz.items.map((i) => ({
        questionId: i.questionId,
        position: i.position,
        type: i.question.type,
        stemText: i.question.stemText,
        points: num(i.pointsOverride ?? i.question.points),
        pointsOverride: i.pointsOverride === null ? null : num(i.pointsOverride),
        archived: i.question.status === 'ARCHIVED',
      })),
      drawRules: drawRules.map(({ average: _average, ...rule }) => rule),
      totalPoints: Math.round(totalPoints * 100) / 100,
      questionCount: fixed ? activeItems.length : drawRules.reduce((s, r) => s + r.count, 0),
      attemptCount: quiz._count.attempts,
      problems,
    };
  }
}
