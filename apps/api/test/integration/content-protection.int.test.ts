import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BOOTSTRAP_STORAGE_LOCATION_ID } from '../../src/modules/platform';
import { type Harness, SCHOOLS, startHarness } from '../setup/school-harness';

const { acme: ACME } = SCHOOLS;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses

/** Content protection and downloads (docs/design/content-protection.md). */
describe('content protection and downloads', () => {
  let h: Harness;
  const cookies: Record<string, string> = {};
  let courseId = '';
  let lessonId = '';
  let videoLessonId = '';
  const files = { pdf: '', docx: '' };

  const sql = (text: string, params: unknown[] = []) =>
    h.asTenant(h.tenants.acme, () => h.migrator.query(text, params));
  const get = (url: string, cookie: string) => h.call('GET', url, { host: ACME, cookie });
  const lesson = async (cookie = cookies.learner!): Promise<Json> => {
    const response = await get(`/api/v1/learn/lessons/${lessonId}`, cookie);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const fileUrl = (asset: string, mode?: 'view', cookie = cookies.learner!) =>
    get(
      `/api/v1/learn/lessons/${lessonId}/files/${asset}/url${mode === undefined ? '' : `?mode=${mode}`}`,
      cookie,
    );
  const settings = (body: Json) =>
    h.call('PATCH', '/api/v1/admin/settings', {
      host: ACME,
      cookie: cookies.owner,
      body: { ...body, reason: 'Content protection test' },
    });
  const studio = async (body: Json) => {
    const current = (await get(`/api/v1/studio/courses/${courseId}`, cookies.tutor!)).json();
    return h.call('PATCH', `/api/v1/studio/courses/${courseId}`, {
      host: ACME,
      cookie: cookies.tutor,
      body: { version: current.version, ...body },
    });
  };

  beforeAll(async () => {
    h = await startHarness({ objectStore: true });
    for (const [email, role, name] of [
      ['owner@acme.test', 'TENANT_OWNER', 'Olu Owner'],
      ['tutor@acme.test', 'INSTRUCTOR', 'Tiko Phiri'],
    ] as const) {
      await h.member(ACME, h.tenants.acme, email, name);
      await h.grantRole(h.tenants.acme, email, role);
      cookies[email.split('@')[0]!] = await h.signIn(ACME, email);
    }
    cookies.learner = await h.member(ACME, h.tenants.acme, 'chanda@example.com', 'Chanda Mwila');
    const tutor = (
      await sql(
        `SELECT m.id FROM tenant_membership m JOIN user_account a ON a.id = m.user_id WHERE a.email = 'tutor@acme.test'`,
      )
    ).rows[0].id as string;
    await sql(
      `INSERT INTO instructor_profile (membership_id, tenant_id, slug, display_name, status)
       VALUES ($1, $2, 'tiko', 'Tiko Phiri', 'APPROVED')`,
      [tutor, h.tenants.acme],
    );
    courseId = (
      await sql(
        `INSERT INTO course (tenant_id, owner_membership_id, slug, title, status, first_published_at, published_at)
         VALUES ($1, $2, 'notes', 'Course notes', 'PUBLISHED', now(), now()) RETURNING id`,
        [h.tenants.acme, tutor],
      )
    ).rows[0].id as string;
    const section = (
      await sql(
        `INSERT INTO section (tenant_id, course_id, title, position) VALUES ($1, $2, 'Part 1', 1) RETURNING id`,
        [h.tenants.acme, courseId],
      )
    ).rows[0].id as string;
    lessonId = (
      await sql(
        `INSERT INTO lesson (tenant_id, course_id, section_id, title, type, position, content_json)
         VALUES ($1, $2, $3, 'Reading', 'FILE', 1, '{"type":"doc","content":[]}') RETURNING id`,
        [h.tenants.acme, courseId, section],
      )
    ).rows[0].id as string;
    for (const [key, name, mime] of [
      ['pdf', 'notes.pdf', 'application/pdf'],
      ['docx', 'notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ] as const) {
      files[key] = (
        await sql(
          `INSERT INTO asset (tenant_id, owner_membership_id, kind, purpose, original_name, mime, size_bytes,
             storage_key, storage_location_id, status)
           VALUES ($1, $2, 'DOCUMENT', 'LESSON_FILE', $3, $4, 10, $5, $6, 'READY') RETURNING id`,
          [
            h.tenants.acme,
            tutor,
            name,
            mime,
            `t/${h.tenants.acme}/lesson-files/${name}`,
            BOOTSTRAP_STORAGE_LOCATION_ID,
          ],
        )
      ).rows[0].id as string;
      await sql(`INSERT INTO lesson_attachment (tenant_id, lesson_id, asset_id) VALUES ($1, $2, $3)`, [
        h.tenants.acme,
        lessonId,
        files[key],
      ]);
    }
    const video = (
      await sql(
        `INSERT INTO asset (tenant_id, owner_membership_id, kind, purpose, provider, provider_video_id,
           original_name, mime, size_bytes, status, duration_seconds)
         VALUES ($1, $2, 'VIDEO', 'LESSON_VIDEO', 'fake', 'fake_video', 'clip.mp4', 'video/mp4', 10, 'READY', 60)
         RETURNING id`,
        [h.tenants.acme, tutor],
      )
    ).rows[0].id as string;
    videoLessonId = (
      await sql(
        `INSERT INTO lesson (tenant_id, course_id, section_id, title, type, position, video_asset_id, downloadable)
         VALUES ($1, $2, $3, 'Clip', 'VIDEO', 2, $4, true) RETURNING id`,
        [h.tenants.acme, courseId, section, video],
      )
    ).rows[0].id as string;
    const enrol = await h.call('POST', '/api/v1/courses/notes/enrol', {
      host: ACME,
      cookie: cookies.learner,
    });
    expect(enrol.statusCode, enrol.body).toBe(200);
  }, 240_000);

  afterAll(async () => {
    await h?.close();
  });

  it('by default: protected with the learner’s name, files view-only, the tutor unlimited', async () => {
    const view = await lesson();
    expect(view.protection).toEqual({ watermark: 'Chanda Mwila · chanda@example.com' });
    expect(view.downloadable).toBe(false);

    const refused = await fileUrl(files.pdf);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('DOWNLOAD_NOT_ALLOWED');
    const opened = await fileUrl(files.pdf, 'view');
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json().url).not.toContain('attachment');
    // Office files can't be shown in a browser.
    expect((await fileUrl(files.docx, 'view')).statusCode).toBe(404);

    const tutorView = await lesson(cookies.tutor);
    expect(tutorView).toMatchObject({ protection: null, downloadable: true });
    expect((await fileUrl(files.docx, undefined, cookies.tutor)).statusCode).toBe(200);
  });

  it('the tutor turns protection off and allows downloads to save data', async () => {
    const off = await studio({ protectContent: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({
      protectContent: false,
      contentRules: { contentProtection: 'TUTOR_CHOOSES', downloadPolicy: 'TUTOR_CHOOSES' },
    });
    expect((await lesson()).protection).toBeNull();

    await sql(`UPDATE lesson SET downloadable = true WHERE id = $1`, [lessonId]);
    expect((await lesson()).downloadable).toBe(true);
    const saved = await fileUrl(files.docx);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(decodeURIComponent(saved.json().url)).toContain('attachment');
  });

  it('a school can decide for every course; tutors can’t change it then (audited)', async () => {
    expect((await settings({ contentProtection: 'ALWAYS', downloadPolicy: 'NEVER' })).statusCode).toBe(200);
    expect((await lesson()).protection).not.toBeNull();
    const refused = await studio({ protectContent: null });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors[0]).toMatchObject({ field: 'protectContent', code: 'school_decides' });
    expect((await fileUrl(files.docx)).json().code).toBe('DOWNLOAD_NOT_ALLOWED');

    expect((await settings({ contentProtection: 'NEVER', downloadPolicy: 'ALWAYS' })).statusCode).toBe(200);
    await sql(`UPDATE lesson SET downloadable = false WHERE id = $1`, [lessonId]);
    expect(await lesson()).toMatchObject({ protection: null, downloadable: true });
    expect((await fileUrl(files.docx)).statusCode).toBe(200);

    const audit = await sql(
      `SELECT after FROM audit_log WHERE action = 'settings.updated' ORDER BY created_at DESC`,
    );
    expect(audit.rows[0].after.changes).toMatchObject({ downloadPolicy: { from: 'NEVER', to: 'ALWAYS' } });
    await settings({ contentProtection: 'TUTOR_CHOOSES', downloadPolicy: 'TUTOR_CHOOSES' });
  });

  it('offers a video to save offline only where the video service has one', async () => {
    const view = (await get(`/api/v1/learn/lessons/${videoLessonId}`, cookies.learner!)).json();
    // The fake video service keeps no bytes: nothing to save, even though the lesson allows downloads.
    expect(view.video).toMatchObject({ status: 'READY', downloadable: false });
    expect(
      (await get(`/api/v1/learn/lessons/${videoLessonId}/video/download`, cookies.learner!)).statusCode,
    ).toBe(404);
    await sql(`UPDATE lesson SET downloadable = false WHERE id = $1`, [videoLessonId]);
    const refused = await get(`/api/v1/learn/lessons/${videoLessonId}/video/download`, cookies.learner!);
    expect(refused.json().code).toBe('DOWNLOAD_NOT_ALLOWED');
  });
});
