import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionTenant, TenantResolver } from '../../src/modules/tenancy';
import { type Harness, PASSWORD, SCHOOLS, cookieFrom, startHarness } from '../setup/school-harness';

const { acme: ACME, beta: BETA } = SCHOOLS;
const DELTA = 'delta.localhost';
const UNIQUE_VIOLATION = '23505';

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

interface LessonSpec {
  title: string;
  type?: 'TEXT' | 'VIDEO';
  preview?: boolean;
  required?: boolean;
}

interface SeededCourse {
  id: string;
  slug: string;
  lessons: string[];
}

describe('learning experience (M6)', () => {
  let h: Harness;
  const cookies = { tutor: '', learner: '', stranger: '', admin: '', learnerOnBeta: '', betaTutor: '' };
  let free: SeededCourse;
  let paid: SeededCourse;
  let draft: SeededCourse;
  let betaCourse: SeededCourse;

  const sql = (tenantId: string, text: string, params: unknown[] = []) =>
    h.asTenant(tenantId, () => h.migrator.query(text, params));

  async function membershipOf(tenantId: string, email: string): Promise<string> {
    const { rows } = await sql(
      tenantId,
      `SELECT m.id FROM tenant_membership m JOIN user_account a ON a.id = m.user_id WHERE a.email = $1`,
      [email],
    );
    return (rows[0] as { id: string }).id;
  }

  /** An approved instructor's course, written directly (authoring itself is covered by M5's suite). */
  async function seedCourse(
    tenantId: string,
    ownerEmail: string,
    input: { slug: string; priceMinor?: number; status?: string; lessons: LessonSpec[] },
  ): Promise<SeededCourse> {
    const owner = await membershipOf(tenantId, ownerEmail);
    await sql(
      tenantId,
      `INSERT INTO instructor_profile (membership_id, tenant_id, slug, display_name, status)
       VALUES ($1, $2, $3, 'Teacher', 'APPROVED') ON CONFLICT (membership_id) DO NOTHING`,
      [owner, tenantId, `t-${owner.slice(0, 8)}`],
    );
    const published = (input.status ?? 'PUBLISHED') === 'PUBLISHED';
    const course = await sql(
      tenantId,
      `INSERT INTO course (tenant_id, owner_membership_id, slug, title, price_minor, status, first_published_at, published_at)
       VALUES ($1, $2, $3, $4, $5, $6::"CourseStatus", $7, $7) RETURNING id`,
      [
        tenantId,
        owner,
        input.slug,
        `Course ${input.slug}`,
        input.priceMinor ?? 0,
        input.status ?? 'PUBLISHED',
        published ? new Date() : null,
      ],
    );
    const courseId = (course.rows[0] as { id: string }).id;
    const section = await sql(
      tenantId,
      `INSERT INTO section (tenant_id, course_id, title, position) VALUES ($1, $2, 'Basics', 0) RETURNING id`,
      [tenantId, courseId],
    );
    const sectionId = (section.rows[0] as { id: string }).id;
    const lessons: string[] = [];
    for (const [position, lesson] of input.lessons.entries()) {
      let videoAssetId: string | null = null;
      if (lesson.type === 'VIDEO') {
        const asset = await sql(
          tenantId,
          `INSERT INTO asset (tenant_id, owner_membership_id, kind, purpose, provider, provider_video_id,
             original_name, mime, size_bytes, status, duration_seconds)
           VALUES ($1, $2, 'VIDEO', 'LESSON_VIDEO', 'fake', $3, 'clip.mp4', 'video/mp4', 1000, 'READY', 100)
           RETURNING id`,
          [tenantId, owner, `fake_${input.slug}_${position}`],
        );
        videoAssetId = (asset.rows[0] as { id: string }).id;
      }
      const created = await sql(
        tenantId,
        `INSERT INTO lesson (tenant_id, course_id, section_id, title, type, position, content_json, video_asset_id,
           is_preview, is_required)
         VALUES ($1, $2, $3, $4, $5::"LessonType", $6, $7, $8, $9, $10) RETURNING id`,
        [
          tenantId,
          courseId,
          sectionId,
          lesson.title,
          lesson.type ?? 'TEXT',
          position,
          JSON.stringify(doc(`${lesson.title} content`)),
          videoAssetId,
          lesson.preview ?? false,
          lesson.required ?? true,
        ],
      );
      lessons.push((created.rows[0] as { id: string }).id);
    }
    return { id: courseId, slug: input.slug, lessons };
  }

  const get = (host: string, url: string, cookie?: string) => h.call('GET', url, { host, cookie });
  const progress = (host: string, lessonId: string, cookie: string, body: Record<string, unknown>) =>
    h.call('PUT', `/api/v1/learn/lessons/${lessonId}/progress`, { host, cookie, body });

  beforeAll(async () => {
    h = await startHarness();
    cookies.tutor = await h.member(ACME, h.tenants.acme, 'tutor@acme.test', 'Tiko Phiri');
    await h.grantRole(h.tenants.acme, 'tutor@acme.test', 'INSTRUCTOR');
    cookies.tutor = await h.signIn(ACME, 'tutor@acme.test');
    cookies.learner = await h.member(ACME, h.tenants.acme, 'learner@example.com', 'Chanda Mwila');
    cookies.stranger = await h.member(ACME, h.tenants.acme, 'stranger@example.com', 'Sam Stranger');
    await h.member(ACME, h.tenants.acme, 'admin@acme.test', 'Ada Admin');
    await h.grantRole(h.tenants.acme, 'admin@acme.test', 'TENANT_ADMIN');
    cookies.admin = await h.signIn(ACME, 'admin@acme.test');

    // The same person is also a learner at Beta (one global account, D3). Their account is visible only
    // where they are a member, so its id is read in Acme.
    const { rows: people } = await sql(
      h.tenants.acme,
      `SELECT a.id FROM user_account a JOIN tenant_membership m ON m.user_id = a.id WHERE a.email = $1`,
      ['learner@example.com'],
    );
    await sql(
      h.tenants.beta,
      `WITH m AS (
         INSERT INTO tenant_membership (tenant_id, user_id, status, joined_at)
         VALUES ($1, $2, 'ACTIVE', now()) RETURNING id)
       INSERT INTO membership_role (tenant_id, membership_id, role) SELECT $1, id, 'LEARNER' FROM m`,
      [h.tenants.beta, (people[0] as { id: string }).id],
    );
    cookies.learnerOnBeta = await h.signIn(BETA, 'learner@example.com');
    cookies.betaTutor = await h.member(BETA, h.tenants.beta, 'tutor@beta.test', 'Beta Tutor');

    free = await seedCourse(h.tenants.acme, 'tutor@acme.test', {
      slug: 'cells',
      lessons: [
        { title: 'Welcome', preview: true },
        { title: 'Reading' },
        { title: 'Video', type: 'VIDEO' },
        { title: 'Extra', required: false },
      ],
    });
    paid = await seedCourse(h.tenants.acme, 'tutor@acme.test', {
      slug: 'premium',
      priceMinor: 25_000,
      lessons: [{ title: 'Paid lesson' }],
    });
    draft = await seedCourse(h.tenants.acme, 'tutor@acme.test', {
      slug: 'draft',
      status: 'DRAFT',
      lessons: [{ title: 'Unfinished' }],
    });
    betaCourse = await seedCourse(h.tenants.beta, 'tutor@beta.test', {
      slug: 'cells',
      lessons: [{ title: 'Beta lesson' }],
    });
  }, 240_000);

  afterAll(async () => {
    await h?.close();
  });

  describe('enrolment and entitlements (F14)', () => {
    it('the landing page tells a visitor they can enrol for free, and gives lesson ids', async () => {
      const landing = await get(ACME, '/api/v1/courses/cells');
      expect(landing.statusCode).toBe(200);
      const body = landing.json();
      expect(body.id).toBe(free.id);
      expect(body.sections[0].lessons[0].id).toBe(free.lessons[0]);
      expect(body.viewer).toMatchObject({ signedIn: false, enrollment: null, canEnrolFree: true });
    });

    it('F15 AC 2: a locked lesson never returns content; a preview lesson does', async () => {
      const locked = await get(ACME, `/api/v1/learn/lessons/${free.lessons[1]}`, cookies.stranger);
      expect(locked.statusCode).toBe(403);
      expect(locked.json().code).toBe('ENROLMENT_INACTIVE');
      expect(locked.body).not.toContain('Reading content');
      expect((await get(ACME, `/api/v1/learn/lessons/${free.lessons[1]}`)).statusCode).toBe(401);
      expect((await get(ACME, `/api/v1/learn/courses/${free.id}`, cookies.stranger)).json().code).toBe(
        'ENROLMENT_INACTIVE',
      );

      const preview = await get(ACME, `/api/v1/learn/lessons/${free.lessons[0]}`);
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ access: 'PREVIEW', progress: null, next: null, previous: null });
      expect(JSON.stringify(preview.json().content)).toContain('Welcome content');
    });

    it('a draft course is not found for learners at all', async () => {
      expect((await get(ACME, `/api/v1/learn/courses/${draft.id}`, cookies.learner)).statusCode).toBe(404);
      expect((await get(ACME, `/api/v1/learn/lessons/${draft.lessons[0]}`, cookies.learner)).statusCode).toBe(
        404,
      );
      const enrol = await h.call('POST', `/api/v1/courses/${draft.slug}/enrol`, {
        host: ACME,
        cookie: cookies.learner,
      });
      expect(enrol.statusCode).toBe(404);
    });

    it('enrols for free once; enrolling again returns the same enrolment', async () => {
      const first = await h.call('POST', `/api/v1/courses/${free.slug}/enrol`, {
        host: ACME,
        cookie: cookies.learner,
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        courseId: free.id,
        created: true,
        resumeLessonId: free.lessons[0],
      });
      const again = await h.call('POST', `/api/v1/courses/${free.slug}/enrol`, {
        host: ACME,
        cookie: cookies.learner,
      });
      expect(again.json()).toMatchObject({ enrollmentId: first.json().enrollmentId, created: false });
      const { rows } = await sql(h.tenants.acme, 'SELECT enrollment_count FROM course WHERE id = $1', [
        free.id,
      ]);
      expect((rows[0] as { enrollment_count: number }).enrollment_count).toBe(1);

      const landing = await get(ACME, '/api/v1/courses/cells', cookies.learner);
      expect(landing.json().viewer).toMatchObject({ signedIn: true, canEnrolFree: false });
      expect(landing.json().viewer.enrollment.id).toBe(first.json().enrollmentId);
    });

    it('turning off publicCatalog blocks anonymous lesson previews while an existing enrolment keeps its access', async () => {
      expect(
        (
          await h.call('PUT', '/api/v1/admin/features/publicCatalog', {
            host: ACME,
            cookie: cookies.admin,
            body: { enabled: false },
          })
        ).statusCode,
      ).toBe(204);
      try {
        expect((await get(ACME, `/api/v1/learn/lessons/${free.lessons[0]}`)).statusCode).toBe(401);
        const lesson = await get(ACME, `/api/v1/learn/lessons/${free.lessons[1]}`, cookies.learner);
        expect(lesson.statusCode).toBe(200);
        expect(lesson.json().access).toBe('ENROLLED');
        expect(JSON.stringify(lesson.json().content)).toContain('Reading content');
        expect((await get(BETA, '/api/v1/courses')).statusCode).toBe(200);
      } finally {
        expect(
          (
            await h.call('PUT', '/api/v1/admin/features/publicCatalog', {
              host: ACME,
              cookie: cookies.admin,
              body: { enabled: true },
            })
          ).statusCode,
        ).toBe(204);
      }
    });

    it('refuses free enrolment in a paid course and in one’s own course', async () => {
      const paidEnrol = await h.call('POST', `/api/v1/courses/${paid.slug}/enrol`, {
        host: ACME,
        cookie: cookies.learner,
      });
      expect(paidEnrol.statusCode).toBe(409);
      expect(paidEnrol.json().code).toBe('INVALID_STATE');
      const own = await h.call('POST', `/api/v1/courses/${free.slug}/enrol`, {
        host: ACME,
        cookie: cookies.tutor,
      });
      expect(own.statusCode).toBe(409);
    });

    it('F14 AC 1: the database allows at most one ACTIVE enrolment per person and course', async () => {
      const learner = await membershipOf(h.tenants.acme, 'learner@example.com');
      let code: string | undefined;
      try {
        await sql(
          h.tenants.acme,
          `INSERT INTO enrollment (tenant_id, membership_id, course_id, source) VALUES ($1, $2, $3, 'FREE')`,
          [h.tenants.acme, learner, free.id],
        );
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe(UNIQUE_VIOLATION);
    });

    it('F14 AC 3: the course owner and administrators open the content without enrolling', async () => {
      const asOwner = await get(ACME, `/api/v1/learn/courses/${free.id}`, cookies.tutor);
      expect(asOwner.statusCode).toBe(200);
      expect(asOwner.json()).toMatchObject({ access: 'OWNER', enrollment: null });
      expect((await get(ACME, `/api/v1/learn/courses/${draft.id}`, cookies.tutor)).json().access).toBe(
        'OWNER',
      );
      const asAdmin = await get(ACME, `/api/v1/learn/lessons/${paid.lessons[0]}`, cookies.admin);
      expect(asAdmin.json().access).toBe('ADMIN');
      // Previews by owners and administrators are never recorded as progress.
      const owned = await progress(ACME, free.lessons[0]!, cookies.tutor, { status: 'COMPLETED' });
      expect(owned.json().code).toBe('ENROLMENT_INACTIVE');
    });
  });

  describe('player and progress (F15, BR-22)', () => {
    it('bootstraps the player with the outline, states and counts', async () => {
      const player = await get(ACME, `/api/v1/learn/courses/${free.id}`, cookies.learner);
      expect(player.statusCode, player.body).toBe(200);
      const body = player.json();
      expect(body).toMatchObject({ access: 'ENROLLED', readOnly: false, resume: null });
      expect(body.counts).toEqual({ required: 3, completedRequired: 0 });
      expect(body.sections[0].lessons.map((l: { id: string }) => l.id)).toEqual(free.lessons);
      expect(body.sections[0].lessons[0].status).toBe('NOT_STARTED');
    });

    it('marks a text lesson complete and updates the course progress', async () => {
      const done = await progress(ACME, free.lessons[0]!, cookies.learner, { status: 'COMPLETED' });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({
        lesson: { status: 'COMPLETED' },
        progressPercent: 33,
        courseCompleted: false,
        completedNow: false,
      });
    });

    it('completes a video only at the school’s threshold (90 % of 100 s by default)', async () => {
      const early = await progress(ACME, free.lessons[2]!, cookies.learner, {
        status: 'COMPLETED',
        positionSeconds: 50,
      });
      expect(early.json().lesson).toEqual({ status: 'IN_PROGRESS', positionSeconds: 50 });
      const reached = await progress(ACME, free.lessons[2]!, cookies.learner, { positionSeconds: 92 });
      expect(reached.json().lesson.status).toBe('COMPLETED');

      await h.setSetting(h.tenants.acme, 'videoCompletionThresholdPct', 50);
      const lesson = await get(ACME, `/api/v1/learn/lessons/${free.lessons[2]}`, cookies.learner);
      expect(lesson.json().completionThresholdPct).toBe(50);
      await h.setSetting(h.tenants.acme, 'videoCompletionThresholdPct', 90);
    });

    it('M6 AC 2: the saved position comes back exactly, on another device too', async () => {
      await progress(ACME, free.lessons[2]!, cookies.learner, { positionSeconds: 37 });
      const otherDevice = await h.signIn(ACME, 'learner@example.com');
      const player = (await get(ACME, `/api/v1/learn/courses/${free.id}`, otherDevice)).json();
      expect(player.resume).toEqual({ lessonId: free.lessons[2], positionSeconds: 37 });
      const lesson = (await get(ACME, `/api/v1/learn/lessons/${free.lessons[2]}`, otherDevice)).json();
      expect(lesson.progress).toEqual({ status: 'COMPLETED', positionSeconds: 37 });
      const mine = (await get(ACME, '/api/v1/me/enrollments', otherDevice)).json();
      expect(mine.items[0].resume).toMatchObject({ lessonId: free.lessons[2], positionSeconds: 37 });
    });

    it('plays the video through the provider port (simulated by the fake provider)', async () => {
      const playback = await get(ACME, `/api/v1/learn/lessons/${free.lessons[2]}/playback`, cookies.learner);
      expect(playback.statusCode, playback.body).toBe(200);
      expect(playback.json()).toMatchObject({ kind: 'simulated', durationSeconds: 100 });
      const stranger = await get(ACME, `/api/v1/learn/lessons/${free.lessons[2]}/playback`, cookies.stranger);
      expect(stranger.statusCode).toBe(403);
    });

    it('signs only files attached to the lesson', async () => {
      const response = await get(
        ACME,
        `/api/v1/learn/lessons/${free.lessons[1]}/files/0d6c2b1e-0000-4000-8000-000000000000/url`,
        cookies.learner,
      );
      expect(response.statusCode).toBe(404);
    });

    it('BR-22: completing the last required lesson completes the course once', async () => {
      const last = await progress(ACME, free.lessons[1]!, cookies.learner, { status: 'COMPLETED' });
      expect(last.json()).toMatchObject({ progressPercent: 100, courseCompleted: true, completedNow: true });
      const optional = await progress(ACME, free.lessons[3]!, cookies.learner, { status: 'COMPLETED' });
      expect(optional.json()).toMatchObject({ courseCompleted: true, completedNow: false });
      const mine = (await get(ACME, '/api/v1/me/enrollments', cookies.learner)).json();
      expect(mine.items).toHaveLength(1);
      expect(mine.items[0]).toMatchObject({
        progressPercent: 100,
        course: { id: free.id, instructorName: 'Teacher' },
      });
      expect(mine.items[0].completedAt).not.toBeNull();
    });

    it('validates progress input', async () => {
      const empty = await progress(ACME, free.lessons[0]!, cookies.learner, {});
      expect(empty.statusCode).toBe(422);
      const negative = await progress(ACME, free.lessons[0]!, cookies.learner, { positionSeconds: -1 });
      expect(negative.statusCode).toBe(422);
    });
  });

  describe('M6 AC 1: entitlements never cross schools', () => {
    it('the same person’s Acme enrolment is invisible and unusable on Beta', async () => {
      const cookie = cookies.learnerOnBeta;
      expect((await get(BETA, `/api/v1/learn/courses/${free.id}`, cookie)).statusCode).toBe(404);
      expect((await get(BETA, `/api/v1/learn/lessons/${free.lessons[1]}`, cookie)).statusCode).toBe(404);
      expect((await progress(BETA, free.lessons[1]!, cookie, { status: 'COMPLETED' })).statusCode).toBe(404);
      expect(
        (await h.call('POST', `/api/v1/courses/${paid.slug}/enrol`, { host: BETA, cookie })).statusCode,
      ).toBe(404);
      expect((await get(BETA, '/api/v1/me/enrollments', cookie)).json().items).toEqual([]);
    });

    it('an Acme session replayed on Beta is anonymous there', async () => {
      const replay = await get(BETA, `/api/v1/learn/courses/${betaCourse.id}`, cookies.learner);
      expect(replay.statusCode).toBe(401);
    });

    it('a Beta enrolment stays on Beta', async () => {
      const enrol = await h.call('POST', `/api/v1/courses/${betaCourse.slug}/enrol`, {
        host: BETA,
        cookie: cookies.learnerOnBeta,
      });
      expect(enrol.statusCode, enrol.body).toBe(200);
      const onBeta = (await get(BETA, '/api/v1/me/enrollments', cookies.learnerOnBeta)).json();
      expect(onBeta.items.map((i: { course: { id: string } }) => i.course.id)).toEqual([betaCourse.id]);
      const onAcme = (await get(ACME, '/api/v1/me/enrollments', cookies.learner)).json();
      expect(onAcme.items.map((i: { course: { id: string } }) => i.course.id)).toEqual([free.id]);
      // The course slug "cells" exists in both schools; each host resolves its own.
      expect((await get(BETA, '/api/v1/courses/cells')).json().id).toBe(betaCourse.id);
    });

    it('the database refuses an enrolment pointing at another school’s membership', async () => {
      const acmeMembership = await membershipOf(h.tenants.acme, 'stranger@example.com');
      let code: string | undefined;
      try {
        await sql(
          h.tenants.beta,
          `INSERT INTO enrollment (tenant_id, membership_id, course_id, source) VALUES ($1, $2, $3, 'FREE')`,
          [h.tenants.beta, acmeMembership, betaCourse.id],
        );
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe('23503');
    });
  });

  describe('administration: grant, revoke, expiry, learners', () => {
    it('S-T09: the owner sees learners by display name, without emails', async () => {
      const learners = await get(ACME, `/api/v1/studio/courses/${free.id}/learners`, cookies.tutor);
      expect(learners.statusCode).toBe(200);
      expect(learners.json().items).toHaveLength(1);
      expect(learners.json().items[0]).toMatchObject({ name: 'Chanda Mwila', progressPercent: 100 });
      expect(learners.body).not.toContain('learner@example.com');
      expect(
        (await get(ACME, `/api/v1/studio/courses/${free.id}/learners`, cookies.learner)).statusCode,
      ).toBe(404);
    });

    it('F14 AC 2: revoking removes access on the next request; history is kept', async () => {
      const list = (await get(ACME, `/api/v1/admin/courses/${free.id}/enrollments`, cookies.admin)).json();
      const enrollmentId = list.items[0].enrollmentId as string;
      expect(list.items[0]).toMatchObject({ email: 'learner@example.com', status: 'ACTIVE', source: 'FREE' });
      const revoked = await h.call('POST', `/api/v1/admin/enrollments/${enrollmentId}/revoke`, {
        host: ACME,
        cookie: cookies.admin,
        body: { reason: 'Requested by the learner' },
      });
      expect(revoked.statusCode, revoked.body).toBe(204);
      const after = await get(ACME, `/api/v1/learn/courses/${free.id}`, cookies.learner);
      expect(after.statusCode).toBe(403);
      expect(after.json().code).toBe('ENROLMENT_INACTIVE');
      expect((await get(ACME, '/api/v1/me/enrollments', cookies.learner)).json().items).toEqual([]);

      const again = await h.call('POST', `/api/v1/courses/${free.slug}/enrol`, {
        host: ACME,
        cookie: cookies.learner,
      });
      expect(again.json()).toMatchObject({ created: true });
      expect(again.json().enrollmentId).not.toBe(enrollmentId);
      const history = (await get(ACME, `/api/v1/admin/courses/${free.id}/enrollments`, cookies.admin)).json();
      expect(history.items.map((i: { status: string }) => i.status).sort()).toEqual(['ACTIVE', 'REVOKED']);
      const audit = await sql(h.tenants.acme, `SELECT action FROM audit_log WHERE entity_id = $1`, [
        enrollmentId,
      ]);
      expect(audit.rows.map((r) => (r as { action: string }).action)).toEqual(['enrollment.revoked']);
    });

    it('administrators grant access to a paid course by email, once', async () => {
      const grant = (email: string) =>
        h.call('POST', `/api/v1/admin/courses/${paid.id}/enrollments`, {
          host: ACME,
          cookie: cookies.admin,
          body: { email, reason: 'Scholarship' },
        });
      const granted = await grant('stranger@example.com');
      expect(granted.statusCode, granted.body).toBe(201);
      expect((await get(ACME, `/api/v1/learn/courses/${paid.id}`, cookies.stranger)).json().access).toBe(
        'ENROLLED',
      );
      expect((await grant('stranger@example.com')).json().code).toBe('ALREADY_ENROLLED');
      expect((await grant('nobody@example.com')).statusCode).toBe(422);
      const asLearner = await h.call('POST', `/api/v1/admin/courses/${paid.id}/enrollments`, {
        host: ACME,
        cookie: cookies.learner,
        body: { email: 'learner@example.com', reason: 'Myself' },
      });
      expect(asLearner.statusCode).toBe(403);
    });

    it('BR-12: an expired enrolment stops working on the next request and is marked EXPIRED', async () => {
      await sql(
        h.tenants.acme,
        `UPDATE enrollment SET expires_at = now() - interval '1 minute' WHERE course_id = $1 AND status = 'ACTIVE'`,
        [paid.id],
      );
      const response = await get(ACME, `/api/v1/learn/courses/${paid.id}`, cookies.stranger);
      expect(response.json().code).toBe('ENROLMENT_INACTIVE');
      const { rows } = await sql(h.tenants.acme, `SELECT status FROM enrollment WHERE course_id = $1`, [
        paid.id,
      ]);
      expect(rows).toEqual([{ status: 'EXPIRED' }]);
    });

    it('enrolled learners keep access when the course is unpublished (PROPOSED 3)', async () => {
      await sql(h.tenants.acme, `UPDATE course SET status = 'UNPUBLISHED' WHERE id = $1`, [free.id]);
      try {
        const player = await get(ACME, `/api/v1/learn/courses/${free.id}`, cookies.learner);
        expect(player.json()).toMatchObject({ access: 'ENROLLED', course: { status: 'UNPUBLISHED' } });
        expect((await get(ACME, `/api/v1/learn/courses/${free.id}`, cookies.stranger)).statusCode).toBe(404);
      } finally {
        await sql(h.tenants.acme, `UPDATE course SET status = 'PUBLISHED' WHERE id = $1`, [free.id]);
      }
    });
  });

  describe('M6 AC 3: a suspended school is read-only (BR-52)', () => {
    let delta = '';
    let deltaCourse: SeededCourse;
    let learnerCookie = '';

    beforeAll(async () => {
      const created = await provisionTenant(h.migrator, {
        slug: 'delta',
        name: 'Delta School',
        kind: 'SCHOOL',
        hostname: DELTA,
        status: 'ACTIVE',
      });
      if (created.outcome !== 'created') throw new Error('provisioning failed');
      delta = created.tenantId;
      await h.member(DELTA, delta, 'tutor@delta.test', 'Delta Tutor');
      learnerCookie = await h.member(DELTA, delta, 'learner@delta.test', 'Delta Learner');
      deltaCourse = await seedCourse(delta, 'tutor@delta.test', {
        slug: 'history',
        lessons: [{ title: 'One' }, { title: 'Two' }],
      });
      const enrol = await h.call('POST', `/api/v1/courses/${deltaCourse.slug}/enrol`, {
        host: DELTA,
        cookie: learnerCookie,
      });
      expect(enrol.statusCode).toBe(200);
      await progress(DELTA, deltaCourse.lessons[0]!, learnerCookie, { status: 'COMPLETED' });
      await sql(delta, `UPDATE tenant SET status = 'SUSPENDED' WHERE id = $1`, [delta]);
      h.app.get(TenantResolver).invalidate();
    });

    it('enrolled learners keep reading their content', async () => {
      const player = await get(DELTA, `/api/v1/learn/courses/${deltaCourse.id}`, learnerCookie);
      expect(player.statusCode, player.body).toBe(200);
      expect(player.json()).toMatchObject({ readOnly: true, access: 'ENROLLED' });
      expect(player.json().counts.completedRequired).toBe(1);
      const lesson = await get(DELTA, `/api/v1/learn/lessons/${deltaCourse.lessons[1]}`, learnerCookie);
      expect(lesson.json()).toMatchObject({ readOnly: true, title: 'Two' });
      expect((await get(DELTA, '/api/v1/me/enrollments', learnerCookie)).json().items).toHaveLength(1);
    });

    it('refuses every write: progress, enrolment, registration, authoring', async () => {
      const writes = [
        progress(DELTA, deltaCourse.lessons[1]!, learnerCookie, { status: 'COMPLETED' }),
        h.call('POST', `/api/v1/courses/${deltaCourse.slug}/enrol`, { host: DELTA, cookie: learnerCookie }),
        h.call('POST', '/api/v1/auth/register', {
          host: DELTA,
          body: { displayName: 'New', email: 'new@delta.test', password: PASSWORD, acceptTerms: true },
        }),
        h.call('POST', '/api/v1/studio/courses', {
          host: DELTA,
          cookie: learnerCookie,
          body: { title: 'Nope nope' },
        }),
      ];
      for (const response of await Promise.all(writes)) {
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json().code).toBe('SCHOOL_READ_ONLY');
      }
      const { rows } = await sql(
        delta,
        `SELECT count(*)::int AS n FROM lesson_progress WHERE status = 'COMPLETED'`,
      );
      expect(rows[0]).toEqual({ n: 1 });
    });

    it('learners can still sign in and out to reach their courses', async () => {
      const signIn = await h.call('POST', '/api/v1/auth/sign-in', {
        host: DELTA,
        body: { email: 'learner@delta.test', password: PASSWORD },
      });
      expect(signIn.statusCode, signIn.body).toBe(200);
      const cookie = cookieFrom(signIn.headers['set-cookie'])!;
      expect((await get(DELTA, `/api/v1/learn/courses/${deltaCourse.id}`, cookie)).statusCode).toBe(200);
      const signOut = await h.call('POST', '/api/v1/auth/sign-out', { host: DELTA, cookie });
      expect(signOut.statusCode).toBeLessThan(300);
    });
  });
});
