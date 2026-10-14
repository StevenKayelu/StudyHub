import { createHmac } from 'node:crypto';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProcessAssetHandler, MEDIA_PROCESS_JOB } from '../../src/modules/media';
import {
  createLogger,
  MALWARE_SCANNER,
  type MalwareScanner,
  OBJECT_STORAGE,
  type ObjectStorage,
  PrismaService,
  runWithContext,
} from '../../src/modules/platform';
import { type Harness, SCHOOLS, startHarness } from '../setup/school-harness';

const { acme: ACME, beta: BETA } = SCHOOLS;
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const FAKE_VIDEO_SECRET = 'studyhub-local-fake-video-secret';

const longText = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(' ');
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('catalogue and authoring (M5)', () => {
  let h: Harness;
  let tutorCookie = '';
  let otherTutorCookie = '';
  let adminCookie = '';
  let betaTutorCookie = '';
  let betaAdminCookie = '';
  let subjectId = '';
  let betaSubjectId = '';

  /** Runs the worker job for an uploaded asset, as the worker would (inside the school's context). */
  async function processAsset(tenantId: string, assetId: string): Promise<void> {
    const handler = createProcessAssetHandler({
      prisma: h.app.get(PrismaService),
      storage: h.app.get<ObjectStorage>(OBJECT_STORAGE),
      scanner: h.app.get<MalwareScanner>(MALWARE_SCANNER),
    });
    await runWithContext({ requestId: 'test', tenantId }, () =>
      handler(
        { type: MEDIA_PROCESS_JOB, tenantId, payload: { assetId }, requestId: 'test' },
        createLogger({ level: 'silent' }),
      ),
    );
  }

  /** Slot → direct PUT to object storage → complete → worker job. Returns the asset status afterwards. */
  async function upload(
    host: string,
    tenantId: string,
    cookie: string,
    file: { purpose: string; name: string; mime: string; body: Buffer },
  ): Promise<{ id: string; status: string }> {
    const slot = await h.call('POST', '/api/v1/uploads', {
      host,
      cookie,
      body: { purpose: file.purpose, fileName: file.name, mime: file.mime, sizeBytes: file.body.length },
    });
    expect(slot.statusCode, slot.body).toBe(201);
    const { assetId, uploadUrl, headers } = slot.json() as {
      assetId: string;
      uploadUrl: string;
      headers: Record<string, string>;
    };
    const put = await fetch(uploadUrl, { method: 'PUT', body: new Uint8Array(file.body), headers });
    expect(put.status).toBe(200);
    expect((await h.call('POST', `/api/v1/uploads/${assetId}/complete`, { host, cookie })).statusCode).toBe(
      200,
    );
    await processAsset(tenantId, assetId);
    const status = await h.call('GET', `/api/v1/assets/${assetId}`, { host, cookie });
    return { id: assetId, status: status.json().status as string };
  }

  const png = () =>
    sharp({ create: { width: 640, height: 360, channels: 3, background: '#a3471c' } })
      .png()
      .toBuffer();

  /** A course that passes the publish checklist. */
  async function readyCourse(host: string, tenantId: string, cookie: string, title: string, subject: string) {
    const created = await h.call('POST', '/api/v1/studio/courses', {
      host,
      cookie,
      body: { title, subjectId: subject },
    });
    expect(created.statusCode, created.body).toBe(201);
    const course = created.json() as { id: string; version: number; slug: string };
    const cover = await upload(host, tenantId, cookie, {
      purpose: 'COURSE_COVER',
      name: 'cover.png',
      mime: 'image/png',
      body: await png(),
    });
    expect(cover.status).toBe('READY');
    const updated = await h.call('PATCH', `/api/v1/studio/courses/${course.id}`, {
      host,
      cookie,
      body: {
        version: course.version,
        subtitle: 'Everything about living things',
        description: doc(longText(60)),
        outcomes: ['Explain cells'],
        coverAssetId: cover.id,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const outline = (
      await h.call('POST', `/api/v1/studio/courses/${course.id}/sections`, {
        host,
        cookie,
        body: { title: 'Basics' },
      })
    ).json();
    const lesson = (
      await h.call('POST', `/api/v1/studio/courses/${course.id}/lessons`, {
        host,
        cookie,
        body: { sectionId: outline.sections[0].id, title: 'What is a cell?', type: 'TEXT' },
      })
    ).json();
    const filled = await h.call('PATCH', `/api/v1/studio/courses/${course.id}/lessons/${lesson.id}`, {
      host,
      cookie,
      body: { version: lesson.version, content: doc('Cells are the basic unit of life.') },
    });
    expect(filled.statusCode, filled.body).toBe(200);
    return { id: course.id, slug: course.slug };
  }

  beforeAll(async () => {
    h = await startHarness({ objectStore: true });
    tutorCookie = await h.member(ACME, h.tenants.acme, 'tutor@acme.test', 'Tiko Phiri');
    await h.grantRole(h.tenants.acme, 'tutor@acme.test', 'INSTRUCTOR');
    tutorCookie = await h.signIn(ACME, 'tutor@acme.test');
    await h.member(ACME, h.tenants.acme, 'tutor2@acme.test', 'Other Tutor');
    await h.grantRole(h.tenants.acme, 'tutor2@acme.test', 'INSTRUCTOR');
    otherTutorCookie = await h.signIn(ACME, 'tutor2@acme.test');
    await h.member(ACME, h.tenants.acme, 'admin@acme.test', 'Acme Admin');
    await h.grantRole(h.tenants.acme, 'admin@acme.test', 'TENANT_ADMIN');
    adminCookie = await h.signIn(ACME, 'admin@acme.test');
    await h.member(BETA, h.tenants.beta, 'tutor@beta.test', 'Beta Tutor');
    await h.grantRole(h.tenants.beta, 'tutor@beta.test', 'INSTRUCTOR');
    betaTutorCookie = await h.signIn(BETA, 'tutor@beta.test');
    await h.member(BETA, h.tenants.beta, 'admin@beta.test', 'Beta Admin');
    await h.grantRole(h.tenants.beta, 'admin@beta.test', 'TENANT_ADMIN');
    betaAdminCookie = await h.signIn(BETA, 'admin@beta.test');

    for (const [host, cookie, set] of [
      [ACME, adminCookie, (id: string) => (subjectId = id)],
      [BETA, betaAdminCookie, (id: string) => (betaSubjectId = id)],
    ] as const) {
      const category = (
        await h.call('POST', '/api/v1/admin/categories', { host, cookie, body: { name: 'Science' } })
      ).json();
      set(
        (
          await h.call('POST', '/api/v1/admin/subjects', {
            host,
            cookie,
            body: { categoryId: category.id, name: 'Biology' },
          })
        ).json().id,
      );
    }
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('authoring (F09, F10, F12)', () => {
    it('a full course goes through review and appears in the catalogue', async () => {
      const course = await readyCourse(ACME, h.tenants.acme, tutorCookie, 'Biology basics', subjectId);
      const checklist = (
        await h.call('GET', `/api/v1/studio/courses/${course.id}/publish-checklist`, {
          host: ACME,
          cookie: tutorCookie,
        })
      ).json();
      expect(checklist.ready).toBe(true);

      const submitted = await h.call('POST', `/api/v1/studio/courses/${course.id}/submit`, {
        host: ACME,
        cookie: tutorCookie,
      });
      expect(submitted.json().status).toBe('IN_REVIEW');
      // Not public until approved.
      expect((await h.call('GET', `/api/v1/courses/${course.slug}`, { host: ACME })).statusCode).toBe(404);

      const queue = (
        await h.call('GET', '/api/v1/admin/course-reviews', { host: ACME, cookie: adminCookie })
      ).json();
      expect(queue.items.map((i: { courseId: string }) => i.courseId)).toContain(course.id);
      expect(
        (
          await h.call('POST', `/api/v1/admin/courses/${course.id}/review`, {
            host: ACME,
            cookie: adminCookie,
            body: { decision: 'APPROVED' },
          })
        ).statusCode,
      ).toBe(204);

      const landing = await h.call('GET', `/api/v1/courses/${course.slug}`, { host: ACME });
      expect(landing.statusCode).toBe(200);
      expect(landing.json()).toMatchObject({
        title: 'Biology basics',
        instructor: { name: 'Tiko Phiri' },
        lessonCount: 1,
      });
      expect(landing.json().coverUrl).toMatch(/^http/);

      // F12 AC 2: unpublishing removes it from the catalogue.
      await h.call('POST', `/api/v1/studio/courses/${course.id}/unpublish`, {
        host: ACME,
        cookie: tutorCookie,
      });
      expect((await h.call('GET', `/api/v1/courses/${course.slug}`, { host: ACME })).statusCode).toBe(404);
      // Republishing needs no new review.
      expect(
        (
          await h.call('POST', `/api/v1/studio/courses/${course.id}/publish`, {
            host: ACME,
            cookie: tutorCookie,
          })
        ).json().status,
      ).toBe('PUBLISHED');
    });

    it('F12 AC 1: an incomplete course cannot be submitted; every failing item is listed', async () => {
      const course = (
        await h.call('POST', '/api/v1/studio/courses', {
          host: ACME,
          cookie: tutorCookie,
          body: { title: 'Unfinished course' },
        })
      ).json();
      const response = await h.call('POST', `/api/v1/studio/courses/${course.id}/submit`, {
        host: ACME,
        cookie: tutorCookie,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('CHECKLIST_INCOMPLETE');
      expect(response.json().items.map((i: { key: string }) => i.key)).toEqual(
        expect.arrayContaining([
          'subtitle',
          'description',
          'subject',
          'cover',
          'outcomes',
          'sections',
          'lessons',
        ]),
      );
    });

    it('F09 AC 1: reordering survives a reload, and a stale write is a 409', async () => {
      const course = (
        await h.call('POST', '/api/v1/studio/courses', {
          host: ACME,
          cookie: tutorCookie,
          body: { title: 'Reorder course' },
        })
      ).json();
      await h.call('POST', `/api/v1/studio/courses/${course.id}/sections`, {
        host: ACME,
        cookie: tutorCookie,
        body: { title: 'One' },
      });
      let outline = (
        await h.call('POST', `/api/v1/studio/courses/${course.id}/sections`, {
          host: ACME,
          cookie: tutorCookie,
          body: { title: 'Two' },
        })
      ).json();
      for (const title of ['A', 'B']) {
        await h.call('POST', `/api/v1/studio/courses/${course.id}/lessons`, {
          host: ACME,
          cookie: tutorCookie,
          body: { sectionId: outline.sections[0].id, title, type: 'TEXT' },
        });
      }
      outline = (
        await h.call('GET', `/api/v1/studio/courses/${course.id}/outline`, {
          host: ACME,
          cookie: tutorCookie,
        })
      ).json();
      const [one, two] = outline.sections;
      const [a, b] = one.lessons;
      // Swap sections; move B into "Two" and put it first.
      const reordered = await h.call('PUT', `/api/v1/studio/courses/${course.id}/outline/order`, {
        host: ACME,
        cookie: tutorCookie,
        body: {
          version: outline.version,
          sections: [
            { id: two.id, lessonIds: [b.id] },
            { id: one.id, lessonIds: [a.id] },
          ],
        },
      });
      expect(reordered.statusCode, reordered.body).toBe(200);
      const reloaded = (
        await h.call('GET', `/api/v1/studio/courses/${course.id}/outline`, {
          host: ACME,
          cookie: tutorCookie,
        })
      ).json();
      expect(
        reloaded.sections.map((s: { title: string; lessons: { title: string }[] }) => [
          s.title,
          s.lessons.map((l) => l.title),
        ]),
      ).toEqual([
        ['Two', ['B']],
        ['One', ['A']],
      ]);
      // The old version is stale now.
      const stale = await h.call('PUT', `/api/v1/studio/courses/${course.id}/outline/order`, {
        host: ACME,
        cookie: tutorCookie,
        body: {
          version: outline.version,
          sections: [
            { id: one.id, lessonIds: [a.id, b.id] },
            { id: two.id, lessonIds: [] },
          ],
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe('VERSION_CONFLICT');
    });

    it('F09 AC 2: another instructor cannot see or edit a draft (404)', async () => {
      const course = (
        await h.call('POST', '/api/v1/studio/courses', {
          host: ACME,
          cookie: tutorCookie,
          body: { title: 'Private draft' },
        })
      ).json();
      expect(
        (await h.call('GET', `/api/v1/studio/courses/${course.id}`, { host: ACME, cookie: otherTutorCookie }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await h.call('PATCH', `/api/v1/studio/courses/${course.id}`, {
            host: ACME,
            cookie: otherTutorCookie,
            body: { version: 1, title: 'Hijacked' },
          })
        ).statusCode,
      ).toBe(404);
      // A learner can't reach Studio at all.
      const learner = await h.member(ACME, h.tenants.acme, 'learner@acme.test');
      expect(
        (await h.call('GET', '/api/v1/studio/courses', { host: ACME, cookie: learner })).statusCode,
      ).toBe(403);
    });

    it('F10 AC 1: unsafe rich text is rejected', async () => {
      const course = (
        await h.call('POST', '/api/v1/studio/courses', {
          host: ACME,
          cookie: tutorCookie,
          body: { title: 'Unsafe content' },
        })
      ).json();
      const response = await h.call('PATCH', `/api/v1/studio/courses/${course.id}`, {
        host: ACME,
        cookie: tutorCookie,
        body: {
          version: course.version,
          description: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'x',
                    marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                  },
                ],
              },
            ],
          },
        },
      });
      expect(response.statusCode).toBe(422);
    });
  });

  describe('school isolation (M5 AC 2, AC 3)', () => {
    it('AC 2: the same course slug can exist in two schools', async () => {
      const acme = (
        await h.call('POST', '/api/v1/studio/courses', {
          host: ACME,
          cookie: tutorCookie,
          body: { title: 'Shared title course' },
        })
      ).json();
      const beta = (
        await h.call('POST', '/api/v1/studio/courses', {
          host: BETA,
          cookie: betaTutorCookie,
          body: { title: 'Shared title course' },
        })
      ).json();
      expect(acme.slug).toBe('shared-title-course');
      expect(beta.slug).toBe('shared-title-course');
    });

    it('AC 3: the catalogue never lists another school’s courses', async () => {
      const course = await readyCourse(
        BETA,
        h.tenants.beta,
        betaTutorCookie,
        'Beta only botany',
        betaSubjectId,
      );
      await h.setSetting(h.tenants.beta, 'courseReviewRequired', false);
      expect(
        (
          await h.call('POST', `/api/v1/studio/courses/${course.id}/submit`, {
            host: BETA,
            cookie: betaTutorCookie,
          })
        ).json().status,
      ).toBe('PUBLISHED');
      const onBeta = (await h.call('GET', '/api/v1/courses', { host: BETA })).json();
      expect(onBeta.items.map((c: { title: string }) => c.title)).toContain('Beta only botany');
      const onAcme = (await h.call('GET', '/api/v1/courses?q=botany', { host: ACME })).json();
      expect(onAcme.items).toEqual([]);
      expect(JSON.stringify((await h.call('GET', '/api/v1/courses', { host: ACME })).json())).not.toContain(
        'Beta only',
      );
      expect((await h.call('GET', `/api/v1/courses/${course.slug}`, { host: ACME })).statusCode).toBe(404);
    });

    it('F13 AC 2: search tolerates a one-letter typo', async () => {
      const result = (await h.call('GET', '/api/v1/courses?q=biolgy', { host: ACME })).json();
      expect(result.items.map((c: { title: string }) => c.title)).toContain('Biology basics');
    });

    it('BR-57: a members-only catalogue needs sign-in', async () => {
      await h.setSetting(h.tenants.acme, 'catalogVisibility', 'MEMBERS_ONLY');
      try {
        expect((await h.call('GET', '/api/v1/courses', { host: ACME })).statusCode).toBe(401);
        expect((await h.call('GET', '/api/v1/courses', { host: ACME, cookie: tutorCookie })).statusCode).toBe(
          200,
        );
      } finally {
        await h.setSetting(h.tenants.acme, 'catalogVisibility', 'PUBLIC');
      }
    });
  });

  describe('uploads (F11, M5 AC 4)', () => {
    it('stores files under the school prefix and makes them READY after checks', async () => {
      const cover = await upload(ACME, h.tenants.acme, tutorCookie, {
        purpose: 'COURSE_COVER',
        name: 'c.png',
        mime: 'image/png',
        body: await png(),
      });
      expect(cover.status).toBe('READY');
      const { rows } = await h.asTenant(h.tenants.acme, () =>
        h.migrator.query<{ storage_key: string; width: number; derivative_key: string }>(
          `SELECT storage_key, width, derivative_key FROM asset WHERE id = $1`,
          [cover.id],
        ),
      );
      expect(rows[0]!.storage_key.startsWith(`t/${h.tenants.acme}/`)).toBe(true);
      expect(rows[0]!.derivative_key).toMatch(/\.webp$/);
      expect(rows[0]!.width).toBe(640);
    });

    it('F11 AC 1: content that does not match its declared type is rejected', async () => {
      const fake = await upload(ACME, h.tenants.acme, tutorCookie, {
        purpose: 'LESSON_FILE',
        name: 'notes.pdf',
        mime: 'application/pdf',
        body: Buffer.from('this is not a pdf at all'),
      });
      expect(fake.status).toBe('REJECTED');
    });

    it('F11 AC 2: an infected file is never READY (EICAR test file)', async () => {
      const infected = await upload(ACME, h.tenants.acme, tutorCookie, {
        purpose: 'LESSON_FILE',
        name: 'notes.pdf',
        mime: 'application/pdf',
        body: Buffer.from(`%PDF-1.7\n${EICAR}\n`),
      });
      expect(infected.status).toBe('REJECTED');
    });

    it('AC 4: a school upload-type restriction is enforced', async () => {
      await h.setSetting(h.tenants.acme, 'allowedUploadTypes', ['application/pdf']);
      try {
        const response = await h.call('POST', '/api/v1/uploads', {
          host: ACME,
          cookie: tutorCookie,
          body: {
            purpose: 'LESSON_FILE',
            fileName: 'slides.pptx',
            mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            sizeBytes: 1000,
          },
        });
        expect(response.statusCode).toBe(422);
        expect(response.json().code).toBe('UPLOAD_TYPE_NOT_ALLOWED');
      } finally {
        await h.setSetting(h.tenants.acme, 'allowedUploadTypes', [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ]);
      }
    });

    it('AC 4: the storage limit blocks new upload slots', async () => {
      // Beta's usage is near the (default 10 GB) quota.
      await h.asTenant(h.tenants.beta, () =>
        h.migrator.query(
          `INSERT INTO tenant_usage (tenant_id, storage_bytes) VALUES ($1, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET storage_bytes = EXCLUDED.storage_bytes`,
          [h.tenants.beta, 10_240 * 1024 * 1024 - 100],
        ),
      );
      const response = await h.call('POST', '/api/v1/uploads', {
        host: BETA,
        cookie: betaTutorCookie,
        body: { purpose: 'LESSON_FILE', fileName: 'big.pdf', mime: 'application/pdf', sizeBytes: 5000 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('LIMIT_REACHED');
      // Acme is unaffected.
      const acme = await h.call('POST', '/api/v1/uploads', {
        host: ACME,
        cookie: tutorCookie,
        body: { purpose: 'LESSON_FILE', fileName: 'small.pdf', mime: 'application/pdf', sizeBytes: 5000 },
      });
      expect(acme.statusCode).toBe(201);
    });
  });

  describe('video webhooks (M5 AC 5)', () => {
    const sign = (body: string) => createHmac('sha256', FAKE_VIDEO_SECRET).update(body).digest('hex');
    const webhook = (body: string, signature = sign(body)) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/video/fake',
        remoteAddress: '203.0.113.50',
        headers: {
          host: 'hooks.example.net',
          'content-type': 'application/json',
          'x-fake-video-signature': signature,
        },
        payload: body,
      });

    it('AC 5: an unknown video id is acknowledged and touches no school data', async () => {
      const count = async (tenantId: string) =>
        (
          await h.asTenant(tenantId, () =>
            h.migrator.query(`SELECT count(*)::int AS n, max(updated_at) AS last FROM asset`),
          )
        ).rows[0];
      const before = [await count(h.tenants.acme), await count(h.tenants.beta)];
      const response = await webhook(
        JSON.stringify({ providerVideoId: 'fake_unknown', status: 'READY', durationSeconds: 5 }),
      );
      expect(response.statusCode).toBe(200);
      expect([await count(h.tenants.acme), await count(h.tenants.beta)]).toEqual(before);
    });

    it('rejects a webhook with a wrong signature', async () => {
      const body = JSON.stringify({ providerVideoId: 'fake_x', status: 'READY' });
      expect((await webhook(body, 'ab'.repeat(32))).statusCode).toBe(403);
    });

    it('a signed webhook finishes the right school’s video', async () => {
      const slot = await h.call('POST', '/api/v1/videos', {
        host: BETA,
        cookie: betaTutorCookie,
        body: { fileName: 'lecture.mp4', mime: 'video/mp4', sizeBytes: 2000 },
      });
      // Beta was filled to its quota above; free it first.
      if (slot.statusCode === 409) {
        await h.asTenant(h.tenants.beta, () => h.migrator.query(`UPDATE tenant_usage SET storage_bytes = 0`));
      }
      const created =
        slot.statusCode === 201
          ? slot
          : await h.call('POST', '/api/v1/videos', {
              host: BETA,
              cookie: betaTutorCookie,
              body: { fileName: 'lecture.mp4', mime: 'video/mp4', sizeBytes: 2000 },
            });
      const { assetId } = created.json() as { assetId: string };
      const { rows } = await h.asTenant(h.tenants.beta, () =>
        h.migrator.query<{ provider_video_id: string }>(`SELECT provider_video_id FROM asset WHERE id = $1`, [
          assetId,
        ]),
      );
      const response = await webhook(
        JSON.stringify({
          providerVideoId: rows[0]!.provider_video_id,
          status: 'READY',
          durationSeconds: 754,
        }),
      );
      expect(response.statusCode).toBe(200);
      const status = (
        await h.call('GET', `/api/v1/assets/${assetId}`, { host: BETA, cookie: betaTutorCookie })
      ).json();
      expect(status).toMatchObject({ status: 'READY', durationSeconds: 754 });
    });
  });

  describe('instructor applications (F06, BR-56)', () => {
    it('in APPLICATION schools a learner applies, an administrator approves, and Studio opens', async () => {
      const learner = await h.member(ACME, h.tenants.acme, 'applicant@acme.test', 'Apply Person');
      // INVITE_ONLY (default): no applications.
      expect(
        (
          await h.call('PUT', '/api/v1/me/instructor', {
            host: ACME,
            cookie: learner,
            body: { displayName: 'Apply Person' },
          })
        ).statusCode,
      ).toBe(403);
      await h.setSetting(h.tenants.acme, 'instructorOnboardingMode', 'APPLICATION');
      expect(
        (
          await h.call('PUT', '/api/v1/me/instructor', {
            host: ACME,
            cookie: learner,
            body: { displayName: 'Apply Person', headline: 'Chemistry teacher' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await h.call('POST', '/api/v1/me/instructor/submit', { host: ACME, cookie: learner })).json().status,
      ).toBe('SUBMITTED');
      const queue = (
        await h.call('GET', '/api/v1/admin/instructor-applications', { host: ACME, cookie: adminCookie })
      ).json();
      const application = queue.items.find((i: { displayName: string }) => i.displayName === 'Apply Person');
      expect(
        (
          await h.call('POST', `/api/v1/admin/instructors/${application.membershipId}/decision`, {
            host: ACME,
            cookie: adminCookie,
            body: { decision: 'APPROVED' },
          })
        ).statusCode,
      ).toBe(204);
      const instructor = await h.signIn(ACME, 'applicant@acme.test');
      expect(
        (
          await h.call('POST', '/api/v1/studio/courses', {
            host: ACME,
            cookie: instructor,
            body: { title: 'Chemistry one' },
          })
        ).statusCode,
      ).toBe(201);
    });

    it('BR-28: a suspended instructor loses Studio and their courses leave the catalogue', async () => {
      const team = (await h.call('GET', '/api/v1/admin/team', { host: ACME, cookie: adminCookie })).json();
      const tutor = team.members.find((m: { email: string }) => m.email === 'tutor@acme.test');
      expect(
        (
          await h.call('POST', `/api/v1/admin/instructors/${tutor.membershipId}/decision`, {
            host: ACME,
            cookie: adminCookie,
            body: { decision: 'SUSPENDED', note: 'Policy review' },
          })
        ).statusCode,
      ).toBe(204);
      const list = (await h.call('GET', '/api/v1/courses', { host: ACME })).json();
      expect(list.items.map((c: { title: string }) => c.title)).not.toContain('Biology basics');
      const tutorAgain = await h.signIn(ACME, 'tutor@acme.test');
      expect(
        (await h.call('GET', '/api/v1/studio/courses', { host: ACME, cookie: tutorAgain })).statusCode,
      ).toBe(403);
      await h.call('POST', `/api/v1/admin/instructors/${tutor.membershipId}/decision`, {
        host: ACME,
        cookie: adminCookie,
        body: { decision: 'APPROVED' },
      });
    });
  });
});
