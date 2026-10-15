import { Injectable } from '@nestjs/common';
import {
  type QuestionList,
  type questionInputSchema,
  type questionListQuerySchema,
  type questionUpdateSchema,
  type QuestionView,
  richTextToPlain,
  sanitizeRichText,
} from '@studyhub/contracts';
import type { z } from 'zod';

import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../audit';
import type { TenantActor } from '../../identity';
import { AppError, requireTenantId, TenantDb, type TenantTx } from '../../platform';
import { questionProblems } from '../domain/quiz-rules';
import { num, ownCourse, ownCourseOf } from './access';

type QuestionInput = z.output<typeof questionInputSchema>;
type QuestionUpdate = z.output<typeof questionUpdateSchema>;
type ListQuery = z.output<typeof questionListQuerySchema>;

const QUESTION_INCLUDE = {
  options: { orderBy: { position: 'asc' as const } },
  _count: { select: { quizItems: true } },
};

type QuestionRow = Prisma.QuestionGetPayload<{ include: typeof QUESTION_INCLUDE }>;

/** Short answers, numeric values and partial credit only where they apply. */
function settingsFor(type: QuestionInput['type'], settings: QuestionInput['settings']) {
  switch (type) {
    case 'MULTIPLE_CHOICE':
      return { partialCredit: settings.partialCredit === true };
    case 'SHORT_ANSWER':
      return {
        acceptedAnswers: (settings.acceptedAnswers ?? []).filter((a) => a.trim() !== ''),
        caseSensitive: settings.caseSensitive === true,
      };
    case 'NUMERIC':
      return {
        value: settings.value,
        tolerance: settings.tolerance ?? 0,
        ...(settings.unit !== undefined && settings.unit !== '' && { unit: settings.unit }),
      };
    default:
      return {};
  }
}

const hasOptions = (type: QuestionInput['type']) =>
  type === 'SINGLE_CHOICE' || type === 'MULTIPLE_CHOICE' || type === 'TRUE_FALSE';

function validate(type: QuestionInput['type'], input: Omit<QuestionInput, 'type'>): void {
  const problems = questionProblems({
    type,
    options: hasOptions(type) ? input.options : [],
    settings: input.settings,
  });
  if (richTextToPlain(input.stem).trim() === '')
    problems.unshift({ field: 'stem', message: 'Write the question' });
  if (problems.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      errors: problems.map((p) => ({ field: p.field, code: 'invalid', message: p.message })),
    });
  }
}

export function toQuestionView(row: QuestionRow): QuestionView {
  return {
    id: row.id,
    courseId: row.courseId,
    type: row.type,
    stem: row.stemJson,
    stemText: row.stemText,
    explanation: row.explanationJson ?? null,
    points: num(row.points),
    difficulty: row.difficulty,
    tags: row.tags,
    practiceEligible: row.practiceEligible,
    settings: row.settings as QuestionView['settings'],
    options: row.options.map((o) => ({
      id: o.id,
      content: typeof o.contentJson === 'string' ? o.contentJson : String(o.contentJson),
      isCorrect: o.isCorrect,
      feedback: typeof o.feedbackJson === 'string' ? o.feedbackJson : null,
    })),
    status: row.status,
    version: row.version,
    usedInQuizzes: row._count.quizItems,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The question bank (F17, S-T05): per course, owned by its instructor. Questions are archived, never
 * deleted, and editing one never changes existing attempts, which keep their own snapshot (BR-19).
 */
@Injectable()
export class BankService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async list(actor: TenantActor, courseId: string, query: ListQuery): Promise<QuestionList> {
    return this.db.run(async (tx) => {
      await ownCourse(tx, actor, courseId);
      const rows = await tx.question.findMany({
        where: {
          courseId,
          status: query.status ?? 'ACTIVE',
          ...(query.type !== undefined && { type: query.type }),
          ...(query.difficulty !== undefined && { difficulty: query.difficulty }),
          ...(query.tag !== undefined && { tags: { has: query.tag } }),
          ...(query.q !== undefined &&
            query.q !== '' && { stemText: { contains: query.q, mode: 'insensitive' } }),
        },
        orderBy: { updatedAt: 'desc' },
        take: 500,
        include: QUESTION_INCLUDE,
      });
      const tags = await tx.$queryRaw<{ tag: string }[]>`
        SELECT DISTINCT unnest(tags) AS tag FROM question WHERE course_id = ${courseId}::uuid AND status = 'ACTIVE'
         ORDER BY 1 LIMIT 200`;
      return { items: rows.map(toQuestionView), tags: tags.map((t) => t.tag) };
    });
  }

  async create(actor: TenantActor, courseId: string, input: QuestionInput): Promise<QuestionView> {
    validate(input.type, input);
    const id = await this.db.run(async (tx) => {
      await ownCourse(tx, actor, courseId);
      const created = await tx.question.create({
        data: {
          tenantId: requireTenantId(),
          courseId,
          createdBy: actor.membershipId,
          type: input.type,
          ...this.fields(input.type, input),
        },
        select: { id: true },
      });
      await this.writeOptions(tx, created.id, input.type, input.options);
      return created.id;
    });
    return this.get(actor, id);
  }

  async get(actor: TenantActor, questionId: string): Promise<QuestionView> {
    return this.db.run(async (tx) => {
      const row = await tx.question.findUnique({ where: { id: questionId }, include: QUESTION_INCLUDE });
      await ownCourseOf(tx, actor, row?.courseId);
      return toQuestionView(row!);
    });
  }

  /** A full edit guarded by the version (409 VERSION_CONFLICT when stale). */
  async update(actor: TenantActor, questionId: string, input: QuestionUpdate): Promise<QuestionView> {
    await this.db.run(async (tx) => {
      const row = await tx.question.findUnique({
        where: { id: questionId },
        select: { courseId: true, type: true, version: true },
      });
      await ownCourseOf(tx, actor, row?.courseId);
      if (row!.version !== input.version) throw new AppError('VERSION_CONFLICT');
      validate(row!.type, input);
      await tx.question.update({
        where: { id: questionId },
        data: {
          ...this.fields(row!.type, input),
          ...(input.status !== undefined && { status: input.status }),
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await this.writeOptions(tx, questionId, row!.type, input.options);
    });
    return this.get(actor, questionId);
  }

  /** F17 AC 3: archived questions leave pickers and new attempts but stay in historical ones. */
  async archive(actor: TenantActor, questionId: string): Promise<void> {
    await this.db.run(async (tx) => {
      const row = await tx.question.findUnique({ where: { id: questionId }, select: { courseId: true } });
      await ownCourseOf(tx, actor, row?.courseId);
      await tx.question.update({
        where: { id: questionId },
        data: { status: 'ARCHIVED', updatedAt: new Date(), version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        action: 'question.archived',
        entityType: 'question',
        entityId: questionId,
        actorId: actor.userId,
      });
    });
  }

  async duplicate(actor: TenantActor, questionId: string): Promise<QuestionView> {
    const id = await this.db.run(async (tx) => {
      const row = await tx.question.findUnique({ where: { id: questionId }, include: QUESTION_INCLUDE });
      await ownCourseOf(tx, actor, row?.courseId);
      const source = row!;
      const copy = await tx.question.create({
        data: {
          tenantId: requireTenantId(),
          courseId: source.courseId,
          createdBy: actor.membershipId,
          type: source.type,
          stemJson: source.stemJson as object,
          stemText: source.stemText,
          explanationJson:
            source.explanationJson === null ? Prisma.DbNull : (source.explanationJson as object),
          points: source.points,
          difficulty: source.difficulty,
          tags: source.tags,
          practiceEligible: source.practiceEligible,
          settings: source.settings as object,
        },
        select: { id: true },
      });
      for (const option of source.options) {
        await tx.questionOption.create({
          data: {
            tenantId: requireTenantId(),
            questionId: copy.id,
            position: option.position,
            contentJson: option.contentJson as object,
            isCorrect: option.isCorrect,
            feedbackJson: option.feedbackJson === null ? Prisma.DbNull : (option.feedbackJson as object),
          },
        });
      }
      return copy.id;
    });
    return this.get(actor, id);
  }

  // ----------------------------------------------------------------------------------------------

  private fields(type: QuestionInput['type'], input: Omit<QuestionInput, 'type'>) {
    const stem = sanitizeRichText(input.stem);
    return {
      stemJson: stem as object,
      stemText: richTextToPlain(stem).slice(0, 500),
      explanationJson:
        input.explanation === undefined || input.explanation === null
          ? Prisma.DbNull
          : (sanitizeRichText(input.explanation) as object),
      points: new Prisma.Decimal(input.points),
      difficulty: input.difficulty,
      tags: [...new Set(input.tags)],
      // F22 AC 3: never for long answers; otherwise on unless switched off.
      practiceEligible: type === 'LONG_ANSWER' ? false : (input.practiceEligible ?? true),
      settings: settingsFor(type, input.settings) as object,
    };
  }

  /** Options keep their ids by position, so analytics can follow an option across edits. */
  private async writeOptions(
    tx: TenantTx,
    questionId: string,
    type: QuestionInput['type'],
    options: QuestionInput['options'],
  ): Promise<void> {
    const wanted = hasOptions(type) ? options : [];
    const existing = await tx.questionOption.findMany({
      where: { questionId },
      orderBy: { position: 'asc' },
    });
    for (const [position, option] of wanted.entries()) {
      const data = {
        contentJson: option.content,
        isCorrect: option.isCorrect,
        feedbackJson:
          option.feedback === undefined || option.feedback === '' ? Prisma.DbNull : option.feedback,
      };
      const current = existing.find((e) => e.position === position);
      if (current === undefined) {
        await tx.questionOption.create({
          data: { tenantId: requireTenantId(), questionId, position, ...data },
        });
      } else {
        await tx.questionOption.update({ where: { id: current.id }, data });
      }
    }
    const extra = existing.filter((e) => e.position >= wanted.length).map((e) => e.id);
    if (extra.length > 0) await tx.questionOption.deleteMany({ where: { id: { in: extra } } });
  }
}
