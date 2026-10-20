import { Injectable } from '@nestjs/common';
import type {
  AttemptHistory,
  AttemptResult,
  AttemptView,
  MyAssessments,
  QuizIntro,
} from '@studyhub/contracts';

import { Prisma } from '../../../generated/prisma/client';
import type { TenantActor } from '../../identity';
import { grantFor, requireQuizOpen } from '../../learning';
import {
  addToOutbox,
  AppError,
  isSchoolReadOnly,
  RateLimiter,
  requireTenantId,
  TenantDb,
  type TenantTx,
} from '../../platform';
import {
  acceptsAnswers,
  deadlineFor,
  type FeedbackPolicy,
  GRACE_SECONDS,
  overdue,
  reviewVisibility,
  shuffled,
  windowState,
} from '../domain/quiz-rules';
import {
  type AnswerResponse,
  correctAnswer,
  publicQuestion,
  type QuestionSnapshot,
  responseFits,
} from '../domain/scoring';
import { isCourseStaff, num, requireActor } from './access';
import { AUTO_SUBMIT_JOB, finalizeAttempt } from './grading-core';
import { drawWhere } from './quizzes.service';

const UNIQUE_VIOLATION = 'P2002';
const ANSWER_RATE = { limit: 5, windowMs: 1000 } as const;

/** What an attempt freezes at its start (05 §3.5 settings_snapshot). */
export interface SettingsSnapshot {
  title: string;
  feedbackPolicy: FeedbackPolicy;
  showCorrectAnswers: boolean;
  passMarkPercent: number | null;
  closesAt: string | null;
  attemptsAllowed: number | null;
}

/** Builds the frozen question for an attempt (BR-19), shuffling options when asked (never true/false). */
export function snapshotOf(
  question: {
    type: QuestionSnapshot['type'];
    stemJson: unknown;
    explanationJson: unknown;
    settings: unknown;
    tags: string[];
    difficulty: QuestionSnapshot['difficulty'];
    options: { id: string; contentJson: unknown; isCorrect: boolean; feedbackJson: unknown }[];
  },
  shuffleOptions: boolean,
): QuestionSnapshot {
  const options = question.options.map((o) => ({
    id: o.id,
    content: o.contentJson,
    isCorrect: o.isCorrect,
    feedback: o.feedbackJson ?? null,
  }));
  return {
    type: question.type,
    stem: question.stemJson,
    options: shuffleOptions && question.type !== 'TRUE_FALSE' ? shuffled(options) : options,
    settings: (question.settings ?? {}) as QuestionSnapshot['settings'],
    explanation: question.explanationJson ?? null,
    tags: question.tags,
    difficulty: question.difficulty,
  };
}

const OPTIONS = { options: { orderBy: { position: 'asc' as const } } };

/**
 * The quiz attempt engine (F19–F21; BR-16 to BR-20). The server owns the clock: deadlines, the 30 s
 * grace and auto-submission are decided here, never by the browser. Correct answers and explanations
 * leave the server only in results the feedback policy allows (BR-20).
 */
@Injectable()
export class AttemptsService {
  constructor(
    private readonly db: TenantDb,
    private readonly limiter: RateLimiter,
  ) {}

  // --- Intro and start --------------------------------------------------------------------------

  async intro(actor: TenantActor | null, quizId: string): Promise<QuizIntro> {
    const member = requireActor(actor);
    return this.db.run(async (tx) => {
      const { quiz, grant } = await this.reachableQuiz(tx, member, quizId);
      const now = new Date();
      const inProgress = await this.settleOverdue(tx, member.membershipId, quizId, now);
      const attempts = await tx.attempt.findMany({
        where: { quizId, membershipId: member.membershipId, mode: 'ASSESSED' },
        orderBy: { startedAt: 'desc' },
      });
      const used = attempts.filter((a) => a.status !== 'IN_PROGRESS').length;
      const window = windowState(quiz, now);
      const questionCount = await this.questionCount(tx, quiz);
      const blocked =
        grant.access !== 'ENROLLED'
          ? ('NOT_ENROLLED' as const)
          : isSchoolReadOnly()
            ? ('READ_ONLY' as const)
            : inProgress !== null
              ? null
              : window !== 'OPEN'
                ? window
                : quiz.attemptsAllowed !== null && used >= quiz.attemptsAllowed
                  ? ('LIMIT_REACHED' as const)
                  : null;
      return {
        quiz: {
          id: quiz.id,
          courseId: quiz.courseId,
          courseTitle: quiz.course.title,
          title: quiz.title,
          instructions: quiz.instructionsJson ?? null,
          questionCount: questionCount.count,
          totalPoints: questionCount.points,
          timeLimitSeconds: quiz.timeLimitSeconds,
          attemptsAllowed: quiz.attemptsAllowed,
          passMarkPercent: quiz.passMarkPercent,
          opensAt: quiz.opensAt?.toISOString() ?? null,
          closesAt: quiz.closesAt?.toISOString() ?? null,
          feedbackPolicy: quiz.feedbackPolicy,
        },
        window,
        attemptsUsed: used,
        inProgress:
          inProgress === null
            ? null
            : { id: inProgress.id, deadlineAt: inProgress.deadlineAt?.toISOString() ?? null },
        blocked,
        attempts: attempts.map((a) => this.historyItem(a, now)),
        readOnly: isSchoolReadOnly(),
        serverNow: now.toISOString(),
      };
    });
  }

  /**
   * Start (or resume) an assessed attempt. Two simultaneous starts create one attempt (F19 AC 5): the
   * partial unique index keeps one, and the loser returns it.
   */
  async start(actor: TenantActor | null, quizId: string): Promise<{ created: boolean; view: AttemptView }> {
    const member = requireActor(actor);
    let attemptId: string;
    let created: boolean;
    try {
      ({ attemptId, created } = await this.db.run((tx) => this.startIn(tx, member, quizId)));
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      ({ attemptId, created } = await this.db.run((tx) => this.startIn(tx, member, quizId)));
    }
    return { created, view: await this.view(member, attemptId) };
  }

  private async startIn(tx: TenantTx, actor: TenantActor, quizId: string) {
    const { quiz, grant } = await this.reachableQuiz(tx, actor, quizId);
    if (grant.access !== 'ENROLLED' || grant.enrollment === null) throw new AppError('ENROLMENT_INACTIVE');
    const now = new Date();
    const existing = await this.settleOverdue(tx, actor.membershipId, quizId, now);
    if (existing !== null) return { attemptId: existing.id, created: false };
    const window = windowState(quiz, now);
    if (window !== 'OPEN') {
      throw new AppError('QUIZ_NOT_OPEN', {
        detail: window === 'CLOSED' ? 'This quiz has closed.' : 'This quiz isn’t open yet.',
      });
    }
    const previous = await tx.attempt.findMany({
      where: { quizId, membershipId: actor.membershipId, mode: 'ASSESSED' },
      select: { attemptNumber: true },
    });
    if (quiz.attemptsAllowed !== null && previous.length >= quiz.attemptsAllowed) {
      throw new AppError('ATTEMPT_LIMIT_REACHED');
    }
    const questions = await this.drawQuestions(tx, quiz);
    if (questions.length === 0)
      throw new AppError('QUIZ_NOT_OPEN', { detail: 'This quiz has no questions yet.' });
    const deadlineAt = deadlineFor(now, quiz.timeLimitSeconds, quiz.closesAt);
    const settings: SettingsSnapshot = {
      title: quiz.title,
      feedbackPolicy: quiz.feedbackPolicy,
      showCorrectAnswers: quiz.showCorrectAnswers,
      passMarkPercent: quiz.passMarkPercent,
      closesAt: quiz.closesAt?.toISOString() ?? null,
      attemptsAllowed: quiz.attemptsAllowed,
    };
    const tenantId = requireTenantId();
    const attempt = await tx.attempt.create({
      data: {
        tenantId,
        membershipId: actor.membershipId,
        courseId: quiz.courseId,
        quizId,
        mode: 'ASSESSED',
        attemptNumber: Math.max(0, ...previous.map((p) => p.attemptNumber ?? 0)) + 1,
        startedAt: now,
        deadlineAt,
        settingsSnapshot: settings as object,
      },
      select: { id: true },
    });
    for (const [position, { question, points }] of questions.entries()) {
      await tx.attemptItem.create({
        data: {
          tenantId,
          attemptId: attempt.id,
          position,
          questionId: question.id,
          questionSnapshot: snapshotOf(question, quiz.shuffleOptions) as object,
          points: new Prisma.Decimal(points),
        },
      });
    }
    if (deadlineAt !== null) {
      // F19 AC 3: the worker submits it at the deadline + grace, in this school's context (outbox → job).
      const outboxId = await addToOutbox(tx, AUTO_SUBMIT_JOB, { attemptId: attempt.id });
      await tx.outbox.update({
        where: { id: outboxId },
        data: { availableAt: new Date(deadlineAt.getTime() + (GRACE_SECONDS + 1) * 1000) },
      });
    }
    return { attemptId: attempt.id, created: true };
  }

  // --- Running ----------------------------------------------------------------------------------

  /** Resume (F19 AC 1): items in their frozen order, saved answers, the deadline and the server clock. */
  async view(actor: TenantActor | null, attemptId: string): Promise<AttemptView> {
    const member = requireActor(actor);
    return this.db.run(async (tx) => {
      const attempt = await this.ownAttempt(tx, member, attemptId);
      if (
        attempt.mode === 'ASSESSED' &&
        attempt.status === 'IN_PROGRESS' &&
        overdue(attempt.deadlineAt, new Date())
      ) {
        await finalizeAttempt(tx, attempt.id, 'AUTO');
      }
      const fresh = await tx.attempt.findUniqueOrThrow({ where: { id: attemptId } });
      const items = await tx.attemptItem.findMany({
        where: { attemptId },
        include: { answer: true },
        orderBy: { position: 'asc' },
      });
      const settings = fresh.settingsSnapshot as unknown as SettingsSnapshot;
      const feedback: AttemptView['feedback'] = {};
      if (fresh.mode === 'PRACTICE') {
        for (const item of items) {
          if (item.answer?.isCorrect === null || item.answer === null) continue;
          const snapshot = item.questionSnapshot as unknown as QuestionSnapshot;
          feedback[item.id] = {
            isCorrect: item.answer.isCorrect,
            awardedPoints: num(item.answer.awardedPoints),
            correct: correctAnswer(snapshot),
            explanation: snapshot.explanation ?? null,
          };
        }
      }
      return {
        id: fresh.id,
        mode: fresh.mode,
        quizId: fresh.quizId,
        courseId: fresh.courseId,
        title: settings.title ?? '',
        status: fresh.status,
        attemptNumber: fresh.attemptNumber,
        attemptsAllowed: settings.attemptsAllowed ?? null,
        startedAt: fresh.startedAt.toISOString(),
        deadlineAt: fresh.deadlineAt?.toISOString() ?? null,
        serverNow: new Date().toISOString(),
        items: items.map((item) => ({
          id: item.id,
          position: item.position,
          points: num(item.points),
          question: publicQuestion(
            item.questionSnapshot as unknown as QuestionSnapshot,
          ) as AttemptView['items'][number]['question'],
        })),
        answers: Object.fromEntries(
          items
            .filter((item) => item.answer !== null)
            .map((item) => [
              item.id,
              {
                response: item.answer!.response as AnswerResponse,
                clientSeq: item.answer!.clientSeq,
                savedAt: item.answer!.savedAt.toISOString(),
              },
            ]),
        ),
        feedback,
        readOnly: isSchoolReadOnly(),
      };
    });
  }

  /**
   * Autosave one answer (F19). Answers after the deadline + 30 s grace are refused with ATTEMPT_CLOSED
   * (F19 AC 4). `clientSeq` makes retries idempotent: an older or repeated save leaves the stored answer
   * and returns its sequence.
   */
  async saveAnswer(
    actor: TenantActor | null,
    attemptId: string,
    itemId: string,
    input: { response: AnswerResponse; clientSeq: number },
  ) {
    const member = requireActor(actor);
    this.limiter.enforce([[`answers:${attemptId}`, ANSWER_RATE]]);
    return this.db.run(async (tx) => {
      // A shared lock: a submit in progress (FOR UPDATE) finishes first, then this sees it closed.
      const [locked] = await tx.$queryRaw<
        { status: string; deadline_at: Date | null; membership_id: string; mode: string }[]
      >`
        SELECT status, deadline_at, membership_id, mode FROM attempt WHERE id = ${attemptId}::uuid FOR SHARE`;
      if (locked === undefined || locked.membership_id !== member.membershipId)
        throw new AppError('NOT_FOUND');
      if (locked.mode !== 'ASSESSED') throw new AppError('NOT_FOUND');
      if (locked.status !== 'IN_PROGRESS' || !acceptsAnswers(locked.deadline_at, new Date())) {
        throw new AppError('ATTEMPT_CLOSED');
      }
      const item = await tx.attemptItem.findFirst({
        where: { id: itemId, attemptId },
        select: { id: true, questionSnapshot: true },
      });
      if (item === null) throw new AppError('NOT_FOUND');
      if (!responseFits(item.questionSnapshot as unknown as QuestionSnapshot, input.response)) {
        throw new AppError('VALIDATION_FAILED', {
          errors: [{ field: 'response', code: 'shape', message: 'This answer doesn’t fit the question' }],
        });
      }
      const tenantId = requireTenantId();
      const response = JSON.stringify(input.response);
      const [saved] = await tx.$queryRaw<{ client_seq: number; saved_at: Date }[]>`
        INSERT INTO attempt_answer (tenant_id, attempt_item_id, response, client_seq, saved_at)
        VALUES (${tenantId}::uuid, ${itemId}::uuid, ${response}::jsonb, ${input.clientSeq}, now())
        ON CONFLICT (tenant_id, attempt_item_id) DO UPDATE
           SET response = EXCLUDED.response, client_seq = EXCLUDED.client_seq, saved_at = EXCLUDED.saved_at
         WHERE attempt_answer.client_seq < EXCLUDED.client_seq
        RETURNING client_seq, saved_at`;
      if (saved !== undefined) return { clientSeq: saved.client_seq, savedAt: saved.saved_at.toISOString() };
      const stored = await tx.attemptAnswer.findUniqueOrThrow({
        where: { tenantId_attemptItemId: { tenantId, attemptItemId: itemId } },
      });
      return { clientSeq: stored.clientSeq, savedAt: stored.savedAt.toISOString() };
    });
  }

  /** Submit (F19): graded at once, or NEEDS_REVIEW with long answers. Submitting twice is harmless. */
  async submit(actor: TenantActor | null, attemptId: string): Promise<AttemptResult> {
    const member = requireActor(actor);
    await this.db.run(async (tx) => {
      const attempt = await this.ownAttempt(tx, member, attemptId);
      if (attempt.mode !== 'ASSESSED') throw new AppError('NOT_FOUND');
      await finalizeAttempt(tx, attemptId, overdue(attempt.deadlineAt, new Date()) ? 'AUTO' : 'MANUAL');
    });
    return this.result(member, attemptId);
  }

  // --- Results ----------------------------------------------------------------------------------

  /** F21: the learner's own result, filtered by the feedback policy; complete for course staff. */
  async result(actor: TenantActor | null, attemptId: string): Promise<AttemptResult> {
    const member = requireActor(actor);
    return this.db.run(async (tx) => {
      const attempt = await tx.attempt.findUnique({
        where: { id: attemptId },
        include: {
          course: { select: { title: true, ownerMembershipId: true } },
          membership: { select: { displayNameOverride: true, user: { select: { displayName: true } } } },
        },
      });
      if (attempt === null) throw new AppError('NOT_FOUND');
      const own = attempt.membershipId === member.membershipId;
      const staff = isCourseStaff(member, attempt.course);
      if (!own && !staff) throw new AppError('NOT_FOUND');
      if (attempt.status === 'IN_PROGRESS' && attempt.mode === 'ASSESSED') {
        if (overdue(attempt.deadlineAt, new Date())) {
          await finalizeAttempt(tx, attemptId, 'AUTO');
        } else {
          throw new AppError('INVALID_STATE', { detail: 'This attempt hasn’t been submitted yet.' });
        }
      }
      const fresh = await tx.attempt.findUniqueOrThrow({ where: { id: attemptId } });
      const settings = fresh.settingsSnapshot as unknown as SettingsSnapshot;
      const now = new Date();
      const visibility =
        fresh.mode === 'PRACTICE'
          ? { score: true, details: true, correctAnswers: true, opensAt: null }
          : reviewVisibility(settings, now, staff && !own);
      const used =
        fresh.quizId === null
          ? 0
          : await tx.attempt.count({
              where: {
                quizId: fresh.quizId,
                membershipId: fresh.membershipId,
                mode: 'ASSESSED',
                status: { not: 'IN_PROGRESS' },
              },
            });
      const items = visibility.details
        ? await tx.attemptItem.findMany({
            where: { attemptId },
            include: { answer: true },
            orderBy: { position: 'asc' },
          })
        : [];
      const reviewed = fresh.status === 'GRADED';
      return {
        id: fresh.id,
        mode: fresh.mode,
        quizId: fresh.quizId,
        courseId: fresh.courseId,
        quizTitle: settings.title ?? '',
        courseTitle: attempt.course.title,
        learnerName: attempt.membership.displayNameOverride ?? attempt.membership.user.displayName,
        status: fresh.status,
        attemptNumber: fresh.attemptNumber,
        attemptsLeft:
          (settings.attemptsAllowed ?? null) === null ? null : Math.max(0, settings.attemptsAllowed! - used),
        startedAt: fresh.startedAt.toISOString(),
        submittedAt: fresh.submittedAt?.toISOString() ?? null,
        submitKind: fresh.submitKind,
        timeTakenSeconds:
          fresh.submittedAt === null
            ? null
            : Math.round((fresh.submittedAt.getTime() - fresh.startedAt.getTime()) / 1000),
        visibility: { ...visibility, opensAt: visibility.opensAt?.toISOString() ?? null },
        score: visibility.score ? num(fresh.score) : null,
        maxScore: visibility.score ? num(fresh.maxScore) : null,
        percent: visibility.score && fresh.percent !== null ? num(fresh.percent) : null,
        passed: visibility.score && reviewed ? fresh.passed : null,
        passMarkPercent: settings.passMarkPercent ?? null,
        items: items.map((item) => {
          const snapshot = item.questionSnapshot as unknown as QuestionSnapshot;
          return {
            id: item.id,
            position: item.position,
            points: num(item.points),
            question: publicQuestion(snapshot) as AttemptResult['items'][number]['question'],
            response: (item.answer?.response ?? null) as AnswerResponse | null,
            isCorrect: item.answer?.isCorrect ?? (item.answer === null ? false : null),
            awardedPoints:
              item.answer === null
                ? 0
                : item.answer.awardedPoints === null
                  ? null
                  : num(item.answer.awardedPoints),
            correct: visibility.correctAnswers ? correctAnswer(snapshot) : null,
            explanation: visibility.correctAnswers ? (snapshot.explanation ?? null) : null,
            graderComment: item.answer?.graderComment ?? null,
          };
        }),
      };
    });
  }

  /** The learner's own attempts at a quiz (newest first). */
  async history(actor: TenantActor | null, quizId: string): Promise<AttemptHistory> {
    const member = requireActor(actor);
    return this.db.run(async (tx) => {
      await this.reachableQuiz(tx, member, quizId);
      const now = new Date();
      await this.settleOverdue(tx, member.membershipId, quizId, now);
      const attempts = await tx.attempt.findMany({
        where: { quizId, membershipId: member.membershipId, mode: 'ASSESSED' },
        orderBy: { startedAt: 'desc' },
      });
      return { items: attempts.map((a) => this.historyItem(a, now)) };
    });
  }

  /** F16: quizzes open in the learner's courses, and their recent results. */
  async mine(actor: TenantActor | null): Promise<MyAssessments> {
    const member = requireActor(actor);
    return this.db.run(async (tx) => {
      const now = new Date();
      const enrolments = await tx.enrollment.findMany({
        where: {
          membershipId: member.membershipId,
          status: 'ACTIVE',
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { courseId: true, course: { select: { title: true } } },
      });
      const courseTitle = new Map(enrolments.map((e) => [e.courseId, e.course.title]));
      const quizzes = await tx.quiz.findMany({
        where: {
          courseId: { in: [...courseTitle.keys()] },
          status: 'READY',
          OR: [{ opensAt: null }, { opensAt: { lte: now } }],
          AND: [{ OR: [{ closesAt: null }, { closesAt: { gt: now } }] }],
        },
        orderBy: [{ closesAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        take: 50,
      });
      const attempts = await tx.attempt.findMany({
        where: { membershipId: member.membershipId, mode: 'ASSESSED' },
        orderBy: { startedAt: 'desc' },
        take: 200,
      });
      const open = quizzes
        .filter((quiz) => {
          const mineForQuiz = attempts.filter((a) => a.quizId === quiz.id);
          const inProgress = mineForQuiz.some((a) => a.status === 'IN_PROGRESS');
          const passed = mineForQuiz.some((a) => a.status === 'GRADED' && a.passed !== false);
          const used = mineForQuiz.filter((a) => a.status !== 'IN_PROGRESS').length;
          const left = quiz.attemptsAllowed === null || used < quiz.attemptsAllowed;
          return inProgress || (!passed && left);
        })
        .slice(0, 10)
        .map((quiz) => ({
          quizId: quiz.id,
          courseId: quiz.courseId,
          title: quiz.title,
          courseTitle: courseTitle.get(quiz.courseId) ?? '',
          closesAt: quiz.closesAt?.toISOString() ?? null,
          inProgressAttemptId:
            attempts.find((a) => a.quizId === quiz.id && a.status === 'IN_PROGRESS')?.id ?? null,
        }));
      const recent = attempts
        .filter((a) => a.status === 'GRADED' || a.status === 'NEEDS_REVIEW')
        .slice(0, 5)
        .map((a) => {
          const settings = a.settingsSnapshot as unknown as SettingsSnapshot;
          const history = this.historyItem(a, now);
          return {
            attemptId: a.id,
            quizTitle: settings.title ?? '',
            courseTitle: courseTitle.get(a.courseId) ?? '',
            status: a.status,
            percent: history.percent,
            passed: history.passed,
            submittedAt: a.submittedAt?.toISOString() ?? null,
          };
        });
      return { open, recent };
    });
  }

  // ----------------------------------------------------------------------------------------------

  /**
   * A READY quiz of a course the actor can open (enrolled, owner or administrator). Another school's
   * quiz, a draft quiz or a course the actor can't open is not found / locked like a lesson.
   */
  private async reachableQuiz(tx: TenantTx, actor: TenantActor, quizId: string) {
    const quiz = await tx.quiz.findUnique({
      where: { id: quizId },
      include: {
        course: {
          select: { id: true, title: true, status: true, ownerMembershipId: true, firstPublishedAt: true },
        },
      },
    });
    if (quiz === null) throw new AppError('NOT_FOUND');
    const grant = await grantFor(tx, actor, quiz.course);
    // Not enrolled: locked like a lesson (F15 AC 2) when the course is in the catalogue, else not found.
    if (grant === null)
      throw new AppError(quiz.course.status === 'PUBLISHED' ? 'ENROLMENT_INACTIVE' : 'NOT_FOUND');
    if (quiz.status !== 'READY' && grant.access === 'ENROLLED') throw new AppError('NOT_FOUND');
    await requireQuizOpen(tx, grant, quiz.course.id, quiz.id);
    return { quiz, grant };
  }

  /** The actor's in-progress attempt at a quiz, after submitting it if its time ran out. */
  private async settleOverdue(tx: TenantTx, membershipId: string, quizId: string, now: Date) {
    const current = await tx.attempt.findFirst({
      where: { quizId, membershipId, mode: 'ASSESSED', status: 'IN_PROGRESS' },
    });
    if (current === null) return null;
    if (overdue(current.deadlineAt, now)) {
      await finalizeAttempt(tx, current.id, 'AUTO', { now });
      return null;
    }
    return current;
  }

  private async ownAttempt(tx: TenantTx, actor: TenantActor, attemptId: string) {
    const attempt = await tx.attempt.findUnique({ where: { id: attemptId } });
    if (attempt === null || attempt.membershipId !== actor.membershipId) throw new AppError('NOT_FOUND');
    return attempt;
  }

  private historyItem(
    a: {
      id: string;
      attemptNumber: number | null;
      status: AttemptView['status'];
      startedAt: Date;
      submittedAt: Date | null;
      percent: Prisma.Decimal | null;
      passed: boolean | null;
      settingsSnapshot: unknown;
    },
    now: Date,
  ) {
    const settings = a.settingsSnapshot as SettingsSnapshot;
    const visibility = reviewVisibility(settings, now, false);
    const graded = a.status === 'GRADED';
    return {
      id: a.id,
      attemptNumber: a.attemptNumber,
      status: a.status,
      startedAt: a.startedAt.toISOString(),
      submittedAt: a.submittedAt?.toISOString() ?? null,
      percent: visibility.score && graded && a.percent !== null ? num(a.percent) : null,
      passed: visibility.score && graded ? a.passed : null,
    };
  }

  private async questionCount(
    tx: TenantTx,
    quiz: { id: string; courseId: string; selectionMode: 'FIXED' | 'DRAW' },
  ) {
    if (quiz.selectionMode === 'DRAW') {
      const rules = await tx.quizDrawRule.findMany({ where: { quizId: quiz.id } });
      return { count: rules.reduce((s, r) => s + r.count, 0), points: 0 };
    }
    const items = await tx.quizItem.findMany({
      where: { quizId: quiz.id, question: { status: 'ACTIVE' } },
      include: { question: { select: { points: true } } },
    });
    return {
      count: items.length,
      points: items.reduce((s, i) => s + num(i.pointsOverride ?? i.question.points), 0),
    };
  }

  /** The questions of a new attempt: the fixed list (archived ones left out) or a fresh draw. */
  private async drawQuestions(
    tx: TenantTx,
    quiz: { id: string; courseId: string; selectionMode: 'FIXED' | 'DRAW'; shuffleQuestions: boolean },
  ) {
    if (quiz.selectionMode === 'FIXED') {
      const items = await tx.quizItem.findMany({
        where: { quizId: quiz.id, question: { status: 'ACTIVE' } },
        orderBy: { position: 'asc' },
        include: { question: { include: OPTIONS } },
      });
      const list = items.map((i) => ({
        question: i.question,
        points: num(i.pointsOverride ?? i.question.points),
      }));
      return quiz.shuffleQuestions ? shuffled(list) : list;
    }
    const rules = await tx.quizDrawRule.findMany({
      where: { quizId: quiz.id },
      orderBy: { position: 'asc' },
    });
    const chosen: { question: Prisma.QuestionGetPayload<{ include: typeof OPTIONS }>; points: number }[] = [];
    for (const rule of rules) {
      const candidates = await tx.question.findMany({
        where: { ...drawWhere(quiz.courseId, rule), id: { notIn: chosen.map((c) => c.question.id) } },
        include: OPTIONS,
      });
      for (const question of shuffled(candidates).slice(0, rule.count)) {
        chosen.push({ question, points: num(question.points) });
      }
    }
    return quiz.shuffleQuestions ? shuffled(chosen) : chosen;
  }
}
