import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTO_SUBMIT_JOB, createAutoSubmitHandler } from '../../src/modules/assessment';
import {
  createLogger,
  dispatchDueOutbox,
  type JobEnvelope,
  PrismaService,
  runWithContext,
} from '../../src/modules/platform';
import { type Harness, SCHOOLS, startHarness } from '../setup/school-harness';

const { acme: ACME, beta: BETA } = SCHOOLS;

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses

describe('assessment engine (M7)', () => {
  let h: Harness;
  const cookies = { tutor: '', learner: '', stranger: '', admin: '', betaTutor: '', betaLearner: '' };
  let courseId = '';
  let quizLessonId = '';
  const q: Record<string, Json> = {};
  const quizzes: Record<string, Json> = {};
  const silent = createLogger({ level: 'silent' });

  const sql = (tenantId: string, text: string, params: unknown[] = []) =>
    h.asTenant(tenantId, () => h.migrator.query(text, params));
  const membershipOf = async (tenantId: string, email: string) =>
    (
      await sql(
        tenantId,
        `SELECT m.id FROM tenant_membership m JOIN user_account a ON a.id = m.user_id WHERE a.email = $1`,
        [email],
      )
    ).rows[0].id as string;
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    cookie: string,
    body?: unknown,
    host: string = ACME,
  ) => h.call(method, url, { host, cookie, body });

  async function question(body: Json): Promise<Json> {
    const response = await call('POST', `/api/v1/studio/courses/${courseId}/questions`, cookies.tutor, body);
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  }

  /** A quiz with a fixed question list and settings, made READY. */
  async function quiz(title: string, items: Json[], settings: Json = {}): Promise<Json> {
    const created = await call('POST', `/api/v1/studio/courses/${courseId}/quizzes`, cookies.tutor, {
      title,
    });
    expect(created.statusCode, created.body).toBe(201);
    const withItems = await call('PUT', `/api/v1/studio/quizzes/${created.json().id}/items`, cookies.tutor, {
      version: created.json().version,
      selectionMode: 'FIXED',
      items,
    });
    expect(withItems.statusCode, withItems.body).toBe(200);
    const ready = await call('PATCH', `/api/v1/studio/quizzes/${created.json().id}`, cookies.tutor, {
      version: withItems.json().version,
      status: 'READY',
      ...settings,
    });
    expect(ready.statusCode, ready.body).toBe(200);
    return ready.json();
  }

  const start = (quizId: string, cookie = cookies.learner) =>
    call('POST', `/api/v1/learn/quizzes/${quizId}/attempts`, cookie);
  /** Attempt items don't expose question ids; map them through the database (test-only). */
  async function itemsByQuestion(attemptId: string): Promise<Record<string, string>> {
    const { rows } = await sql(
      h.tenants.acme,
      `SELECT id, question_id FROM attempt_item WHERE attempt_id = $1`,
      [attemptId],
    );
    return Object.fromEntries(rows.map((r: Json) => [r.question_id, r.id]));
  }
  /** Saves like the runner does: on 429 (5 saves/s per attempt) it waits for Retry-After and tries again. */
  const save = async (
    attemptId: string,
    questionId: string,
    response: Json,
    clientSeq: number,
    cookie = cookies.learner,
  ): Promise<Awaited<ReturnType<typeof call>>> => {
    const itemId = (await itemsByQuestion(attemptId))[questionId]!;
    for (;;) {
      const result = await call('PUT', `/api/v1/learn/attempts/${attemptId}/answers/${itemId}`, cookie, {
        response,
        clientSeq,
      });
      if (result.statusCode !== 429) return result;
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  };
  const optionId = (question: Json, content: string) =>
    (question.options as Json[]).find((o) => o.content === content)!.id as string;

  beforeAll(async () => {
    h = await startHarness();
    await h.member(ACME, h.tenants.acme, 'tutor@acme.test', 'Tiko Phiri');
    await h.grantRole(h.tenants.acme, 'tutor@acme.test', 'INSTRUCTOR');
    cookies.tutor = await h.signIn(ACME, 'tutor@acme.test');
    cookies.learner = await h.member(ACME, h.tenants.acme, 'learner@example.com', 'Chanda Mwila');
    cookies.stranger = await h.member(ACME, h.tenants.acme, 'stranger@example.com', 'Sam Stranger');
    await h.member(ACME, h.tenants.acme, 'admin@acme.test', 'Ada Admin');
    await h.grantRole(h.tenants.acme, 'admin@acme.test', 'TENANT_ADMIN');
    cookies.admin = await h.signIn(ACME, 'admin@acme.test');
    await h.member(BETA, h.tenants.beta, 'tutor@beta.test', 'Beta Tutor');
    await h.grantRole(h.tenants.beta, 'tutor@beta.test', 'INSTRUCTOR');
    cookies.betaTutor = await h.signIn(BETA, 'tutor@beta.test');
    cookies.betaLearner = await h.member(BETA, h.tenants.beta, 'learner@beta.test', 'Beta Learner');

    // A published course with a reading and a quiz lesson (authoring itself is M5's suite).
    const tutor = await membershipOf(h.tenants.acme, 'tutor@acme.test');
    courseId = (
      await sql(
        h.tenants.acme,
        `INSERT INTO course (tenant_id, owner_membership_id, slug, title, status, first_published_at, published_at)
         VALUES ($1, $2, 'cells', 'Cells and life', 'PUBLISHED', now(), now()) RETURNING id`,
        [h.tenants.acme, tutor],
      )
    ).rows[0].id;
    await sql(
      h.tenants.acme,
      `INSERT INTO instructor_profile (membership_id, tenant_id, slug, display_name, status) VALUES ($1, $2, 'tiko', 'Tiko', 'APPROVED')`,
      [tutor, h.tenants.acme],
    );
    const section = (
      await sql(
        h.tenants.acme,
        `INSERT INTO section (tenant_id, course_id, title, position) VALUES ($1, $2, 'One', 0) RETURNING id`,
        [h.tenants.acme, courseId],
      )
    ).rows[0].id;
    await sql(
      h.tenants.acme,
      `INSERT INTO lesson (tenant_id, course_id, section_id, title, type, position, content_json)
       VALUES ($1, $2, $3, 'Reading', 'TEXT', 0, $4)`,
      [h.tenants.acme, courseId, section, JSON.stringify(doc('Cells'))],
    );
    quizLessonId = (
      await sql(
        h.tenants.acme,
        `INSERT INTO lesson (tenant_id, course_id, section_id, title, type, position) VALUES ($1, $2, $3, 'Check', 'QUIZ', 1) RETURNING id`,
        [h.tenants.acme, courseId, section],
      )
    ).rows[0].id;
    for (const cookie of [cookies.learner, cookies.stranger]) {
      expect((await call('POST', '/api/v1/courses/cells/enrol', cookie)).statusCode).toBe(200);
    }

    q.single = await question({
      type: 'SINGLE_CHOICE',
      stem: doc('Which organelle produces ATP?'),
      explanation: doc('Because B'),
      points: 2,
      tags: ['cells'],
      options: [
        { content: 'Ribosome', isCorrect: false },
        { content: 'Mitochondrion', isCorrect: true },
      ],
    });
    q.multi = await question({
      type: 'MULTIPLE_CHOICE',
      stem: doc('Which are organelles?'),
      points: 3,
      tags: ['cells'],
      settings: { partialCredit: true },
      options: [
        { content: 'Nucleus', isCorrect: true },
        { content: 'Golgi', isCorrect: true },
        { content: 'Vacuole', isCorrect: true },
        { content: 'Atom', isCorrect: false },
      ],
    });
    q.short = await question({
      type: 'SHORT_ANSWER',
      stem: doc('Name the powerhouse of the cell'),
      tags: ['energy'],
      settings: { acceptedAnswers: ['mitochondrion'] },
    });
    q.numeric = await question({
      type: 'NUMERIC',
      stem: doc('g in m/s²?'),
      tags: ['physics'],
      settings: { value: 9.81, tolerance: 0.05, unit: 'm/s²' },
    });
    q.long = await question({ type: 'LONG_ANSWER', stem: doc('Explain osmosis'), points: 5 });
    q.trueFalse = await question({
      type: 'TRUE_FALSE',
      stem: doc('Plant cells have walls'),
      options: [
        { content: 'True', isCorrect: true },
        { content: 'False', isCorrect: false },
      ],
    });
    const fixed = ['single', 'multi', 'short', 'numeric'].map((k) => ({ questionId: q[k]!.id }));
    quizzes.main = await quiz('Cells check', fixed, {
      passMarkPercent: 60,
      attemptsAllowed: 2,
      timeLimitMinutes: 10,
    });
    await sql(h.tenants.acme, `UPDATE lesson SET quiz_id = $1 WHERE id = $2`, [
      quizzes.main.id,
      quizLessonId,
    ]);
  }, 300_000);

  afterAll(async () => {
    await h?.close();
  });

  describe('question bank and quiz builder (F17, F18)', () => {
    it('F17 AC 1: a choice question needs its correct option(s)', async () => {
      const none = await call('POST', `/api/v1/studio/courses/${courseId}/questions`, cookies.tutor, {
        type: 'SINGLE_CHOICE',
        stem: doc('Pick one'),
        options: [
          { content: 'A', isCorrect: false },
          { content: 'B', isCorrect: false },
        ],
      });
      expect(none.statusCode).toBe(422);
      expect(none.json().errors[0].message).toBe('Mark exactly one correct answer');
      const two = await call('POST', `/api/v1/studio/courses/${courseId}/questions`, cookies.tutor, {
        type: 'SINGLE_CHOICE',
        stem: doc('Pick one'),
        options: [
          { content: 'A', isCorrect: true },
          { content: 'B', isCorrect: true },
        ],
      });
      expect(two.statusCode).toBe(422);
      expect(q.long!.practiceEligible).toBe(false);
    });

    it('F18 AC 1/2: an empty quiz can’t be READY; total points are the sum of question points', async () => {
      const empty = await call('POST', `/api/v1/studio/courses/${courseId}/quizzes`, cookies.tutor, {
        title: 'Empty',
      });
      const ready = await call('PATCH', `/api/v1/studio/quizzes/${empty.json().id}`, cookies.tutor, {
        version: empty.json().version,
        status: 'READY',
      });
      expect(ready.statusCode).toBe(422);
      expect(ready.json().errors[0].message).toBe('Add at least one question');
      expect(quizzes.main).toMatchObject({ totalPoints: 7, questionCount: 4, status: 'READY', problems: [] });
      const drawn = await call('PUT', `/api/v1/studio/quizzes/${empty.json().id}/items`, cookies.tutor, {
        version: empty.json().version,
        selectionMode: 'DRAW',
        drawRules: [{ count: 5, tags: ['cells'] }],
      });
      expect(drawn.json().problems[0].message).toMatch(/more questions than the bank has/);
    });

    it('another instructor and another school never see this bank', async () => {
      expect(
        (await call('GET', `/api/v1/studio/questions/${q.single!.id}`, cookies.learner)).statusCode,
      ).toBe(404);
      expect(
        (await call('GET', `/api/v1/studio/questions/${q.single!.id}`, cookies.betaTutor, undefined, BETA))
          .statusCode,
      ).toBe(404);
      expect(
        (await call('GET', `/api/v1/learn/quizzes/${quizzes.main!.id}`, cookies.betaLearner, undefined, BETA))
          .statusCode,
      ).toBe(404);
    });
  });

  describe('attempts (F19, AC 2 and 3)', () => {
    let attempt: Json;

    it('AC 3: two simultaneous starts create one attempt', async () => {
      const [a, b] = await Promise.all([start(quizzes.main!.id), start(quizzes.main!.id)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
      expect(a.json().id).toBe(b.json().id);
      attempt = a.json();
      const { rows } = await sql(
        h.tenants.acme,
        `SELECT count(*)::int AS n FROM attempt WHERE quiz_id = $1`,
        [quizzes.main!.id],
      );
      expect(rows[0]).toEqual({ n: 1 });
      expect(attempt).toMatchObject({ attemptNumber: 1, attemptsAllowed: 2, status: 'IN_PROGRESS' });
      expect(new Date(attempt.deadlineAt).getTime() - new Date(attempt.startedAt).getTime()).toBe(600_000);
    });

    it('AC 2: no answer leakage before submission', async () => {
      const resume = await call('GET', `/api/v1/learn/attempts/${attempt.id}`, cookies.learner);
      const intro = await call('GET', `/api/v1/learn/quizzes/${quizzes.main!.id}`, cookies.learner);
      for (const body of [JSON.stringify(attempt), resume.body, intro.body]) {
        expect(body).not.toMatch(
          /isCorrect|acceptedAnswers|tolerance|explanation|Because B|mitochondrion"|9\.81/,
        );
      }
      expect(resume.json().items.find((i: Json) => i.question.type === 'NUMERIC').question.unit).toBe('m/s²');
    });

    it('saves answers idempotently by clientSeq and refuses answers that don’t fit', async () => {
      const first = await save(
        attempt.id,
        q.single!.id,
        { optionIds: [optionId(q.single!, 'Mitochondrion')] },
        5,
      );
      expect(first.json().clientSeq).toBe(5);
      const stale = await save(attempt.id, q.single!.id, { optionIds: [optionId(q.single!, 'Ribosome')] }, 3);
      expect(stale.statusCode).toBe(200);
      expect(stale.json().clientSeq).toBe(5);
      const wrongShape = await save(attempt.id, q.single!.id, { text: 'B' }, 6);
      expect(wrongShape.statusCode).toBe(422);
      const other = await save(
        attempt.id,
        q.single!.id,
        { optionIds: [optionId(q.single!, 'Mitochondrion')] },
        7,
        cookies.stranger,
      );
      expect(other.statusCode).toBe(404);
      await save(
        attempt.id,
        q.multi!.id,
        { optionIds: [optionId(q.multi!, 'Nucleus'), optionId(q.multi!, 'Golgi')] },
        1,
      );
      await save(attempt.id, q.short!.id, { text: '  Mitochondrion ' }, 1);
      await save(attempt.id, q.numeric!.id, { number: 9.83 }, 1);
      // F19 AC 1: resuming brings back the saved answers.
      const resume = (await call('GET', `/api/v1/learn/attempts/${attempt.id}`, cookies.learner)).json();
      expect(Object.keys(resume.answers)).toHaveLength(4);
    });

    it('AC 3: submitting twice grades once; per-answer points add up (F20 AC 1); BR-22 lesson completes', async () => {
      const [a, b] = await Promise.all([
        call('POST', `/api/v1/learn/attempts/${attempt.id}/submit`, cookies.learner),
        call('POST', `/api/v1/learn/attempts/${attempt.id}/submit`, cookies.learner),
      ]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      const result = a.json();
      // 2 (single) + 3 × 2/3 (partial) + 1 (short) + 1 (numeric) = 6 of 7.
      expect(result).toMatchObject({
        status: 'GRADED',
        score: 6,
        maxScore: 7,
        percent: 85.71,
        passed: true,
        submitKind: 'MANUAL',
      });
      expect(result.items[0].explanation).toEqual(doc('Because B'));
      const { rows } = await sql(
        h.tenants.acme,
        `SELECT t.score, (SELECT sum(a.awarded_points) FROM attempt_answer a JOIN attempt_item i ON i.id = a.attempt_item_id
            WHERE i.attempt_id = t.id) AS total FROM attempt t WHERE t.id = $1`,
        [attempt.id],
      );
      expect(Number(rows[0].score)).toBe(Number(rows[0].total));
      const late = await save(attempt.id, q.single!.id, { optionIds: [optionId(q.single!, 'Ribosome')] }, 99);
      expect(late.json().code).toBe('ATTEMPT_CLOSED');
      const player = (await call('GET', `/api/v1/learn/courses/${courseId}`, cookies.learner)).json();
      const quizLesson = player.sections[0].lessons.find((l: Json) => l.id === quizLessonId);
      expect(quizLesson.status).toBe('COMPLETED');
      expect(player.enrollment.progressPercent).toBe(50);
    });

    it('F19 AC 4: after the deadline and 30 s grace, answers are refused and the attempt submits itself', async () => {
      const second = (await start(quizzes.main!.id)).json();
      expect(second.attemptNumber).toBe(2);
      await save(second.id, q.single!.id, { optionIds: [optionId(q.single!, 'Mitochondrion')] }, 1);
      await sql(
        h.tenants.acme,
        `UPDATE attempt SET deadline_at = now() - interval '31 seconds' WHERE id = $1`,
        [second.id],
      );
      const late = await save(second.id, q.short!.id, { text: 'mitochondrion' }, 2);
      expect(late.statusCode).toBe(409);
      expect(late.json().code).toBe('ATTEMPT_CLOSED');
      const result = (
        await call('GET', `/api/v1/learn/attempts/${second.id}/result`, cookies.learner)
      ).json();
      expect(result).toMatchObject({
        status: 'GRADED',
        submitKind: 'AUTO',
        score: 2,
        percent: 28.57,
        passed: false,
        attemptsLeft: 0,
      });
      const third = await start(quizzes.main!.id);
      expect(third.json().code).toBe('ATTEMPT_LIMIT_REACHED');
      const intro = (await call('GET', `/api/v1/learn/quizzes/${quizzes.main!.id}`, cookies.learner)).json();
      expect(intro).toMatchObject({ blocked: 'LIMIT_REACHED', attemptsUsed: 2 });
    });

    it('a learner who isn’t enrolled is locked out; owners and admins can’t take assessed attempts', async () => {
      expect((await start(quizzes.main!.id, cookies.admin)).json().code).toBe('ENROLMENT_INACTIVE');
      const intro = await call('GET', `/api/v1/learn/quizzes/${quizzes.main!.id}`, cookies.tutor);
      expect(intro.json().blocked).toBe('NOT_ENROLLED');
    });
  });

  describe('AC 4: auto-submit runs in the right school', () => {
    it('the outbox carries the attempt’s school; a job in another school’s context changes nothing', async () => {
      const timed = await quiz('Timed', [{ questionId: q.trueFalse!.id }], { timeLimitMinutes: 1 });
      const attempt = (await start(timed.id, cookies.stranger)).json();
      const { rows } = await sql(
        h.tenants.acme,
        `SELECT tenant_id, payload, available_at FROM outbox WHERE topic = $1 AND payload->>'attemptId' = $2`,
        [AUTO_SUBMIT_JOB, attempt.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(h.tenants.acme);
      expect(new Date(rows[0].available_at).getTime() - new Date(attempt.deadlineAt).getTime()).toBe(31_000);

      // Time passes: the deadline (+ grace) is behind us and the outbox row is due.
      await sql(
        h.tenants.acme,
        `UPDATE attempt SET deadline_at = now() - interval '40 seconds' WHERE id = $1`,
        [attempt.id],
      );
      await sql(
        h.tenants.acme,
        `UPDATE outbox SET available_at = now() - interval '1 second' WHERE payload->>'attemptId' = $1`,
        [attempt.id],
      );
      const sent: { name: string; data: JobEnvelope }[] = [];
      const boss = {
        send: (name: string, data: JobEnvelope) => (sent.push({ name, data }), Promise.resolve('job')),
      };
      const prisma = h.app.get(PrismaService);
      await dispatchDueOutbox({ prisma, boss: boss as unknown as PgBoss, logger: silent });
      const job = sent.find((s) => s.name === AUTO_SUBMIT_JOB && s.data.payload.attemptId === attempt.id);
      expect(job?.data.tenantId).toBe(h.tenants.acme);

      const handler = createAutoSubmitHandler({ prisma });
      // A forged job naming Acme's attempt in Beta's context finds nothing (RLS) and does nothing.
      await runWithContext({ requestId: 'forged', tenantId: h.tenants.beta }, () =>
        handler({ ...job!.data, tenantId: h.tenants.beta }, silent),
      );
      const before = await sql(h.tenants.acme, `SELECT status FROM attempt WHERE id = $1`, [attempt.id]);
      expect(before.rows[0].status).toBe('IN_PROGRESS');
      // The real job, in the envelope's own school, submits it.
      await runWithContext({ requestId: 'job', tenantId: job!.data.tenantId! }, () =>
        handler(job!.data, silent),
      );
      const after = await sql(h.tenants.acme, `SELECT status, submit_kind FROM attempt WHERE id = $1`, [
        attempt.id,
      ]);
      expect(after.rows[0]).toEqual({ status: 'GRADED', submit_kind: 'AUTO' });
      // Running it again (at-least-once delivery) is harmless.
      await runWithContext({ requestId: 'job', tenantId: job!.data.tenantId! }, () =>
        handler(job!.data, silent),
      );
    });
  });

  describe('manual grading and feedback policies (F20, F21)', () => {
    it('a long answer waits for the tutor; the last mark grades the attempt', async () => {
      const essay = await quiz('Essay', [{ questionId: q.long!.id }, { questionId: q.trueFalse!.id }], {
        passMarkPercent: 50,
      });
      const attempt = (await start(essay.id)).json();
      await save(attempt.id, q.long!.id, { text: 'Water moves across a membrane.' }, 1);
      await save(attempt.id, q.trueFalse!.id, { optionIds: [optionId(q.trueFalse!, 'True')] }, 1);
      const submitted = (
        await call('POST', `/api/v1/learn/attempts/${attempt.id}/submit`, cookies.learner)
      ).json();
      expect(submitted).toMatchObject({ status: 'NEEDS_REVIEW', passed: null });

      const queue = (
        await call('GET', `/api/v1/studio/courses/${courseId}/grading-queue`, cookies.tutor)
      ).json();
      const item = queue.items.find((i: Json) => i.attemptId === attempt.id);
      expect(item).toMatchObject({
        learnerName: 'Chanda Mwila',
        points: 5,
        response: 'Water moves across a membrane.',
      });
      const tooMany = await call(
        'PUT',
        `/api/v1/studio/attempts/${attempt.id}/items/${item.itemId}/grade`,
        cookies.tutor,
        { points: 6 },
      );
      expect(tooMany.statusCode).toBe(422);
      expect(
        (
          await call(
            'PUT',
            `/api/v1/studio/attempts/${attempt.id}/items/${item.itemId}/grade`,
            cookies.learner,
            { points: 5 },
          )
        ).statusCode,
      ).toBe(404);
      const graded = await call(
        'PUT',
        `/api/v1/studio/attempts/${attempt.id}/items/${item.itemId}/grade`,
        cookies.tutor,
        {
          points: 4,
          comment: 'Good, mention concentration.',
        },
      );
      expect(graded.json()).toEqual({ attemptStatus: 'GRADED' });
      const result = (
        await call('GET', `/api/v1/learn/attempts/${attempt.id}/result`, cookies.learner)
      ).json();
      expect(result).toMatchObject({ status: 'GRADED', score: 5, maxScore: 6, percent: 83.33, passed: true });
      expect(result.items.find((i: Json) => i.question.type === 'LONG_ANSWER').graderComment).toBe(
        'Good, mention concentration.',
      );
    });

    it('F21 AC: AFTER_CLOSE hides the review until the quiz closes, then shows it by itself', async () => {
      const closesAt = new Date(Date.now() + 3_600_000).toISOString();
      const later = await quiz('Later', [{ questionId: q.trueFalse!.id }], {
        feedbackPolicy: 'AFTER_CLOSE',
        closesAt,
      });
      const attempt = (await start(later.id)).json();
      await save(attempt.id, q.trueFalse!.id, { optionIds: [optionId(q.trueFalse!, 'False')] }, 1);
      const hidden = (
        await call('POST', `/api/v1/learn/attempts/${attempt.id}/submit`, cookies.learner)
      ).json();
      expect(hidden.visibility).toMatchObject({ score: true, details: false, opensAt: closesAt });
      expect(hidden.items).toEqual([]);
      const staff = (await call('GET', `/api/v1/studio/attempts/${attempt.id}`, cookies.tutor)).json();
      expect(staff.items).toHaveLength(1);
      // The quiz closes (the attempt keeps the closing time it started with).
      await sql(
        h.tenants.acme,
        `UPDATE attempt SET settings_snapshot = jsonb_set(settings_snapshot, '{closesAt}', to_jsonb((now() - interval '1 minute')::text))
          WHERE id = $1`,
        [attempt.id],
      );
      const shown = (
        await call('GET', `/api/v1/learn/attempts/${attempt.id}/result`, cookies.learner)
      ).json();
      expect(shown.visibility.details).toBe(true);
      expect(shown.items[0]).toMatchObject({
        isCorrect: false,
        correct: { optionIds: [optionId(q.trueFalse!, 'True')] },
      });
    });

    it('NEVER shows learners no score at all', async () => {
      const never = await quiz('Never', [{ questionId: q.trueFalse!.id }], { feedbackPolicy: 'NEVER' });
      const attempt = (await start(never.id)).json();
      const result = (
        await call('POST', `/api/v1/learn/attempts/${attempt.id}/submit`, cookies.learner)
      ).json();
      expect(result).toMatchObject({ score: null, percent: null, passed: null, items: [] });
      expect(JSON.stringify(result)).not.toMatch(/isCorrect":true|correct":\{/);
    });
  });

  describe('BR-19 and F17 AC 2/3: edits and archiving never change past attempts', () => {
    it('the old attempt keeps its snapshot; archived questions leave the bank list', async () => {
      const first = (
        await call(
          'GET',
          `/api/v1/studio/courses/${courseId}/attempts?quizId=${quizzes.main!.id}`,
          cookies.tutor,
        )
      ).json();
      const attemptId = first.items.find((a: Json) => a.attemptNumber === 1).id;
      const edited = await call('PATCH', `/api/v1/studio/questions/${q.single!.id}`, cookies.tutor, {
        version: q.single!.version,
        stem: doc('Edited stem'),
        points: 2,
        tags: ['cells'],
        options: [
          { content: 'Ribosome', isCorrect: false },
          { content: 'Mitochondrion', isCorrect: true },
        ],
      });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(
        (await call('DELETE', `/api/v1/studio/questions/${q.short!.id}`, cookies.tutor)).statusCode,
      ).toBe(204);
      const result = (await call('GET', `/api/v1/studio/attempts/${attemptId}`, cookies.tutor)).json();
      expect(JSON.stringify(result.items[0].question.stem)).toContain('Which organelle produces ATP?');
      expect(result.items).toHaveLength(4);
      const bank = (await call('GET', `/api/v1/studio/courses/${courseId}/questions`, cookies.tutor)).json();
      expect(bank.items.map((i: Json) => i.id)).not.toContain(q.short!.id);
      const view = (await call('GET', `/api/v1/studio/quizzes/${quizzes.main!.id}`, cookies.tutor)).json();
      expect(view.items.find((i: Json) => i.questionId === q.short!.id).archived).toBe(true);
    });
  });

  describe('practice (F22) and features (AC 6)', () => {
    let practiceId = '';

    it('draws from practice-eligible questions only, with immediate feedback', async () => {
      const setup = (await call('GET', `/api/v1/learn/courses/${courseId}/practice`, cookies.learner)).json();
      // single, multi, numeric, true/false (short is archived; long answers never, AC 3).
      expect(setup).toMatchObject({ available: 4, defaultCount: 10, mistakesModeEnabled: true });
      const started = await call('POST', `/api/v1/learn/courses/${courseId}/practice`, cookies.learner, {
        count: 10,
      });
      expect(started.statusCode, started.body).toBe(201);
      const session = started.json();
      practiceId = session.id;
      expect(session).toMatchObject({ mode: 'PRACTICE', quizId: null, deadlineAt: null });
      expect(session.items).toHaveLength(4);
      expect(JSON.stringify(session)).not.toMatch(/isCorrect|explanation/);
      const itemIds = await itemsByQuestion(session.id);
      const feedback = await call(
        'PUT',
        `/api/v1/learn/practice/${session.id}/answers/${itemIds[q.single!.id]}`,
        cookies.learner,
        {
          response: { optionIds: [optionId(q.single!, 'Ribosome')] },
        },
      );
      expect(feedback.json()).toMatchObject({
        isCorrect: false,
        awardedPoints: 0,
        correct: { optionIds: [optionId(q.single!, 'Mitochondrion')] },
      });
      const summary = (
        await call('POST', `/api/v1/learn/practice/${session.id}/finish`, cookies.learner)
      ).json();
      expect(summary).toMatchObject({
        answered: 1,
        total: 4,
        score: 0,
        weakTags: [{ tag: 'cells', correct: 0, total: 1 }],
      });
      const mistakes = (
        await call('GET', `/api/v1/learn/courses/${courseId}/practice`, cookies.learner)
      ).json();
      // Wrong in the last 30 days, in quizzes or practice: multiple choice (partly right), true/false, single.
      expect(mistakes.mistakesAvailable).toBe(3);
    });

    it('F22 AC 1/2: only enrolled learners practise; practice never shows in Studio results', async () => {
      expect(
        (await call('GET', `/api/v1/learn/courses/${courseId}/practice`, cookies.admin)).json().code,
      ).toBe('ENROLMENT_INACTIVE');
      const all = (await call('GET', `/api/v1/studio/courses/${courseId}/attempts`, cookies.tutor)).json();
      expect(all.items.map((a: Json) => a.id)).not.toContain(practiceId);
    });

    it('AC 6: a disabled feature answers FEATURE_NOT_ENABLED and keeps its data', async () => {
      await sql(
        h.tenants.acme,
        `INSERT INTO tenant_feature (tenant_id, feature_key, enabled_by_tenant) VALUES ($1, 'practiceMode', false), ($1, 'quizAnalytics', false)`,
        [h.tenants.acme],
      );
      for (const response of [
        await call('GET', `/api/v1/learn/courses/${courseId}/practice`, cookies.learner),
        await call('POST', `/api/v1/learn/courses/${courseId}/practice`, cookies.learner, {}),
        await call('POST', `/api/v1/learn/practice/${practiceId}/finish`, cookies.learner),
        await call('GET', `/api/v1/studio/quizzes/${quizzes.main!.id}/analytics`, cookies.tutor),
      ]) {
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json().code).toBe('FEATURE_NOT_ENABLED');
      }
      const bootstrap = (await call('GET', '/api/v1/tenant', '')).json();
      expect(bootstrap.features).toMatchObject({
        practiceMode: false,
        quizAnalytics: false,
        paidCourses: true,
      });
      const kept = await sql(
        h.tenants.acme,
        `SELECT count(*)::int AS n FROM attempt WHERE mode = 'PRACTICE'`,
      );
      expect(kept.rows[0]).toEqual({ n: 1 });
      // Switching it back on brings everything back (F40 AC 2).
      await sql(h.tenants.acme, `DELETE FROM tenant_feature WHERE tenant_id = $1`, [h.tenants.acme]);
      expect(
        (await call('POST', `/api/v1/learn/practice/${practiceId}/finish`, cookies.learner)).json().answered,
      ).toBe(1);
    });
  });

  describe('analytics (F23)', () => {
    it('numbers match the attempts made in this suite', async () => {
      const analytics = await call(
        'GET',
        `/api/v1/studio/quizzes/${quizzes.main!.id}/analytics`,
        cookies.tutor,
      );
      expect(analytics.statusCode, analytics.body).toBe(200);
      const body = analytics.json();
      // Attempt 1: 85.71 % (passed); attempt 2: 28.57 % (auto-submitted, failed).
      expect(body).toMatchObject({ attempts: 2, averagePercent: 57.14, medianPercent: 57.14, passRate: 50 });
      expect(body.distribution).toEqual([0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
      const single = body.questions.find((x: Json) => x.questionId === q.single!.id);
      expect(single).toMatchObject({ answered: 2, correctRate: 100 });
      const multi = body.questions.find((x: Json) => x.questionId === q.multi!.id);
      expect(multi).toMatchObject({ answered: 1, correctRate: 0 });
      expect(multi.options.map((o: Json) => o.picks)).toEqual([1, 1, 0, 0]);
    });
  });

  describe('My learning (F16)', () => {
    it('lists open quizzes and recent results', async () => {
      const mine = (await call('GET', '/api/v1/me/assessments', cookies.learner)).json();
      expect(mine.recent.length).toBeGreaterThan(0);
      expect(mine.open.map((o: Json) => o.quizId)).not.toContain(quizzes.main!.id);
    });
  });
});
