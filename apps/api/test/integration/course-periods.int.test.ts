import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Harness, SCHOOLS, startHarness } from '../setup/school-harness';

const { acme: ACME } = SCHOOLS;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses

const DAY_MS = 86_400_000;

/** Terms, semesters and seminars (docs/design/course-periods.md), end to end. */
describe('course periods', () => {
  let h: Harness;
  const cookies: Record<string, string> = {};
  let courseId = '';
  let openCourseId = '';
  const lessons: string[] = [];
  let quizId = '';
  let ip = 1;

  const req = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    options: { cookie?: string; body?: unknown } = {},
  ) =>
    h.app.inject({
      method,
      url,
      remoteAddress: '127.0.0.1',
      headers: {
        host: ACME,
        'x-forwarded-for': `203.0.113.${(ip++ % 250) + 1}`,
        ...(options.cookie !== undefined && { cookie: options.cookie }),
        ...(method !== 'GET' && { origin: `http://${ACME}` }),
        ...(options.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(options.body !== undefined && { payload: JSON.stringify(options.body) }),
    });
  const ok = async (response: Awaited<ReturnType<typeof req>>, status = 200): Promise<Json> => {
    expect(response.statusCode, response.body).toBe(status);
    return status === 204 ? {} : response.json();
  };
  const sql = (text: string, params: unknown[] = []) =>
    h.asTenant(h.tenants.acme, () => h.migrator.query(text, params));
  const owner = () => cookies['owner@acme.test']!;
  const tutor = () => cookies['tutor@acme.test']!;
  const learner = () => cookies['l1@example.com']!;
  const studio = async (id: string, body: Json) => {
    const current = await ok(await req('GET', `/api/v1/studio/courses/${id}`, { cookie: tutor() }));
    return req('PATCH', `/api/v1/studio/courses/${id}`, {
      cookie: tutor(),
      body: { version: current.version, ...body },
    });
  };
  const lesson = (n: number) => req('GET', `/api/v1/learn/lessons/${lessons[n]}`, { cookie: learner() });

  beforeAll(async () => {
    h = await startHarness();
    for (const [email, role, name] of [
      ['owner@acme.test', 'TENANT_OWNER', 'Olu Owner'],
      ['tutor@acme.test', 'INSTRUCTOR', 'Tiko Phiri'],
    ] as const) {
      await h.member(ACME, h.tenants.acme, email, name);
      await h.grantRole(h.tenants.acme, email, role);
      cookies[email] = await h.signIn(ACME, email);
    }
    cookies['l1@example.com'] = await h.member(ACME, h.tenants.acme, 'l1@example.com', 'Learner 1');
    const tutorId = (
      await sql(
        `SELECT m.id FROM tenant_membership m JOIN user_account a ON a.id = m.user_id WHERE a.email = 'tutor@acme.test'`,
      )
    ).rows[0].id as string;
    await sql(
      `INSERT INTO instructor_profile (membership_id, tenant_id, slug, display_name, status)
       VALUES ($1, $2, 'tiko', 'Tiko Phiri', 'APPROVED')`,
      [tutorId, h.tenants.acme],
    );
    for (const [slug, title] of [
      ['algebra-term-2', 'Algebra for term two'],
      ['public-speaking', 'Public speaking skills'],
    ]) {
      const id = (
        await sql(
          `INSERT INTO course (tenant_id, owner_membership_id, slug, title, status, first_published_at, published_at)
           VALUES ($1, $2, $3, $4, 'PUBLISHED', now(), now()) RETURNING id`,
          [h.tenants.acme, tutorId, slug, title],
        )
      ).rows[0].id as string;
      if (slug === 'public-speaking') openCourseId = id;
      else courseId = id;
    }
    const sectionId = (
      await sql(
        `INSERT INTO section (tenant_id, course_id, title, position) VALUES ($1, $2, 'Part 1', 1) RETURNING id`,
        [h.tenants.acme, courseId],
      )
    ).rows[0].id as string;
    // Three lessons; the first is a free preview, the third a quiz.
    for (let position = 1; position <= 3; position += 1) {
      lessons.push(
        (
          await sql(
            `INSERT INTO lesson (tenant_id, course_id, section_id, title, type, position, is_preview, content_json)
             VALUES ($1, $2, $3, $4, 'TEXT', $5, $6, '{"type":"doc","content":[]}') RETURNING id`,
            [h.tenants.acme, courseId, sectionId, `Lesson ${position}`, position, position === 1],
          )
        ).rows[0].id as string,
      );
    }
    quizId = (
      await sql(
        `INSERT INTO quiz (tenant_id, course_id, title, status) VALUES ($1, $2, 'Check', 'READY') RETURNING id`,
        [h.tenants.acme, courseId],
      )
    ).rows[0].id as string;
    await sql(`UPDATE lesson SET type = 'QUIZ', quiz_id = $2 WHERE id = $1`, [lessons[2], quizId]);
  }, 240_000);

  afterAll(async () => {
    await h?.close();
  });

  let termId = '';

  it('administrators create periods; tutors and learners cannot', async () => {
    const startsAt = new Date(Date.now() + 10 * DAY_MS).toISOString();
    const body = { name: 'Term 2 2027', kind: 'TERM', startsAt };
    expect((await req('POST', '/api/v1/admin/periods', { cookie: tutor(), body })).statusCode).toBe(403);
    const bad = await req('POST', '/api/v1/admin/periods', {
      cookie: owner(),
      body: { ...body, endsAt: new Date(Date.now() - DAY_MS).toISOString() },
    });
    expect(bad.statusCode).toBe(422);
    termId = (await ok(await req('POST', '/api/v1/admin/periods', { cookie: owner(), body }), 201)).id;
    await ok(
      await req('POST', '/api/v1/admin/periods', {
        cookie: owner(),
        body: { name: 'Semester 1', kind: 'SEMESTER', startsAt: new Date(Date.now() - DAY_MS).toISOString() },
      }),
      201,
    );
    const list = await ok(await req('GET', '/api/v1/periods', { cookie: learner() }));
    expect(list.periods.map((p: Json) => [p.name, p.kind, p.open])).toEqual([
      ['Semester 1', 'SEMESTER', true],
      ['Term 2 2027', 'TERM', false],
    ]);
    const audit = await sql(`SELECT action FROM audit_log WHERE entity_id = $1`, [termId]);
    expect(audit.rows.map((r) => r.action)).toContain('period.created');
  });

  it('tutors put a course in a period in Studio; open courses have none', async () => {
    const missing = await studio(courseId, { periodId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().errors[0]).toMatchObject({ field: 'periodId', code: 'not_found' });
    const saved = await ok(await studio(courseId, { periodId: termId }));
    expect(saved).toMatchObject({
      periodId: termId,
      accessOverride: null,
      lock: { periodName: 'Term 2 2027' },
    });

    const catalogue = await ok(await req('GET', '/api/v1/courses', { cookie: learner() }));
    const card = catalogue.items.find((c: Json) => c.slug === 'algebra-term-2');
    expect(card.period).toMatchObject({ id: termId, name: 'Term 2 2027', kind: 'TERM' });
    expect(card.lock.opensAt).not.toBeNull();
    const byTerm = await ok(await req('GET', `/api/v1/courses?period=${termId}`, { cookie: learner() }));
    expect(byTerm.items.map((c: Json) => c.slug)).toEqual(['algebra-term-2']);
    const open = await ok(await req('GET', '/api/v1/courses?period=open', { cookie: learner() }));
    expect(open.items.map((c: Json) => c.slug)).toEqual(['public-speaking']);
    expect(open.items[0]).toMatchObject({ period: null, lock: null });
  });

  it('learners enrol in advance, but content stays locked until the term opens', async () => {
    const landing = await ok(await req('GET', '/api/v1/courses/algebra-term-2', { cookie: learner() }));
    expect(landing.viewer.canEnrolFree).toBe(true);
    expect(landing.lock).not.toBeNull();
    await ok(await req('POST', '/api/v1/courses/algebra-term-2/enrol', { cookie: learner() }));

    const player = await ok(await req('GET', `/api/v1/learn/courses/${courseId}`, { cookie: learner() }));
    expect(player.lock).toMatchObject({ periodName: 'Term 2 2027' });
    expect(player.sections[0].lessons.map((l: Json) => l.locked)).toEqual([false, true, true]);
    await ok(await lesson(0));
    const locked = await lesson(1);
    expect(locked.statusCode).toBe(403);
    expect(locked.json()).toMatchObject({ code: 'COURSE_NOT_OPEN', courseId, periodName: 'Term 2 2027' });
    const progress = await req('PUT', `/api/v1/learn/lessons/${lessons[1]}/progress`, {
      cookie: learner(),
      body: { status: 'COMPLETED', positionSeconds: 0 },
    });
    expect(progress.json().code).toBe('COURSE_NOT_OPEN');
    const attempt = await req('POST', `/api/v1/learn/quizzes/${quizId}/attempts`, { cookie: learner() });
    expect(attempt.json().code).toBe('COURSE_NOT_OPEN');
    const practice = await req('POST', `/api/v1/learn/courses/${courseId}/practice`, {
      cookie: learner(),
      body: { count: 1 },
    });
    expect(practice.json().code).toBe('COURSE_NOT_OPEN');
    const mine = await ok(await req('GET', '/api/v1/me/enrollments', { cookie: learner() }));
    expect(mine.items[0].lock).toMatchObject({ periodName: 'Term 2 2027' });

    // The tutor and administrators still open everything.
    await ok(await req('GET', `/api/v1/learn/lessons/${lessons[1]}`, { cookie: tutor() }));
    await ok(await req('GET', `/api/v1/learn/lessons/${lessons[1]}`, { cookie: owner() }));
  });

  it('opens on its start date, and the end date never locks it again', async () => {
    await sql(
      `UPDATE academic_period SET starts_at = now() - interval '30 days', ends_at = now() - interval '1 day' WHERE id = $1`,
      [termId],
    );
    await ok(await lesson(1));
    const player = await ok(await req('GET', `/api/v1/learn/courses/${courseId}`, { cookie: learner() }));
    expect(player.lock).toBeNull();
  });

  it('administrators keep a period locked or open it early, and override single courses', async () => {
    const lock = (body: Json) => req('PATCH', `/api/v1/admin/periods/${termId}`, { cookie: owner(), body });
    expect(
      (await req('PATCH', `/api/v1/admin/periods/${termId}`, { cookie: tutor(), body: { mode: 'LOCKED' } }))
        .statusCode,
    ).toBe(403);
    await ok(await lock({ mode: 'LOCKED' }), 204);
    expect((await lesson(1)).json()).toMatchObject({ code: 'COURSE_NOT_OPEN', opensAt: null });

    // One course opened on its own while its term stays locked.
    const override = (body: Json) =>
      req('PATCH', `/api/v1/admin/courses/${courseId}/period`, { cookie: owner(), body });
    expect(
      (
        await req('PATCH', `/api/v1/admin/courses/${courseId}/period`, {
          cookie: tutor(),
          body: { accessOverride: 'OPEN' },
        })
      ).statusCode,
    ).toBe(403);
    await ok(await override({ accessOverride: 'OPEN' }), 204);
    await ok(await lesson(1));
    const admin = await ok(await req('GET', '/api/v1/admin/courses', { cookie: owner() }));
    expect(admin.courses.find((c: Json) => c.id === courseId)).toMatchObject({
      period: { id: termId },
      accessOverride: 'OPEN',
      lock: null,
    });

    // A locked course stays locked even if its tutor makes it an open course.
    await ok(await override({ accessOverride: 'LOCKED' }), 204);
    await ok(await studio(courseId, { periodId: null }));
    expect((await lesson(1)).json()).toMatchObject({ code: 'COURSE_NOT_OPEN', periodName: null });

    await ok(await override({ periodId: termId, accessOverride: null }), 204);
    await ok(await lock({ mode: 'OPEN' }), 204);
    await ok(await lesson(1));

    // Archived periods leave the pickers; their courses keep them.
    await ok(await lock({ archived: true }), 204);
    const list = await ok(await req('GET', '/api/v1/periods', { cookie: learner() }));
    expect(list.periods.map((p: Json) => p.id)).not.toContain(termId);
    const all = await ok(await req('GET', '/api/v1/admin/periods', { cookie: owner() }));
    expect(all.periods.find((p: Json) => p.id === termId)).toMatchObject({ archived: true, courseCount: 1 });
    expect((await studio(openCourseId, { periodId: termId })).statusCode).toBe(422);
  });
});
