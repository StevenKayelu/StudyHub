import {
  adminSettingsSchema,
  configurationImportPreviewSchema,
  configurationViewSchema,
  MANAGED_CONTENT_KEYS,
  type ConfigurationView,
  type ManagedContentKey,
  type ManagedContentValues,
} from '@studyhub/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { issueToken, runWithContext, TenantDb } from '../../src/modules/platform';
import { CONTENT_DEFAULTS_KEY, CONTENT_DRAFT_KEY, readContentSettings } from '../../src/modules/tenancy';
import { type Harness, SCHOOLS, SESSION, startHarness } from '../setup/school-harness';

type School = keyof typeof SCHOOLS;
type Response = Awaited<ReturnType<Harness['call']>>;
type StaffRole = 'PLATFORM_OWNER' | 'PLATFORM_OPERATOR' | 'PLATFORM_SUPPORT';
const CONSOLE = 'console.localhost';
const CONSOLE_COOKIE = '__Host-sh_console';
const SCHOOL_PATH = '/api/v1/admin/configuration';
const CONSOLE_PATH = '/console/configuration';
const DEFAULTS = { catalogVisibility: 'PUBLIC', courseReviewRequired: true, downloadsAllowedDefault: false };

describe('versioned content configuration over HTTP', () => {
  let h: Harness;
  const owners = {} as Record<School, string>;
  const staff = {} as Record<StaffRole, string>;
  let learner = '';

  const status = (response: Response, expected = 200) => {
    expect(response.statusCode, response.body).toBe(expected);
    return response;
  };
  const viewOf = (response: Response) => configurationViewSchema.parse(status(response).json());
  const schoolCall = (
    which: School,
    method: Parameters<Harness['call']>[0],
    suffix = '',
    body?: unknown,
    cookie = owners[which],
  ) => h.call(method, `${SCHOOL_PATH}${suffix}`, { host: SCHOOLS[which], cookie, body });
  const consoleCall = (
    method: Parameters<Harness['call']>[0],
    suffix = '',
    body?: unknown,
    role: StaffRole = 'PLATFORM_OWNER',
  ) => h.call(method, `${CONSOLE_PATH}${suffix}`, { host: CONSOLE, cookie: staff[role], body });
  const schoolView = async (which: School) => viewOf(await schoolCall(which, 'GET'));
  const platformView = async () => viewOf(await consoleCall('GET'));

  async function platformSql(text: string, parameters: unknown[] = []) {
    await h.migrator.query('BEGIN');
    try {
      await h.migrator.query(`SELECT set_config('app.realm', 'platform', true)`);
      const result = await h.migrator.query(text, parameters);
      await h.migrator.query('COMMIT');
      return result;
    } catch (error) {
      await h.migrator.query('ROLLBACK');
      throw error;
    }
  }

  async function saveSchool(which: School, values: ManagedContentValues, reason: string) {
    const current = await schoolView(which);
    return viewOf(
      await schoolCall(which, 'PUT', '/draft', {
        expectedRevision: current.revision,
        values,
        lockedKeys: [],
        reason,
      }),
    );
  }

  async function savePlatform(values: ManagedContentValues, lockedKeys: ManagedContentKey[], reason: string) {
    const current = await platformView();
    return viewOf(
      await consoleCall('PUT', '/draft', {
        expectedRevision: current.revision,
        values,
        lockedKeys,
        reason,
      }),
    );
  }

  function activation(view: ConfigurationView) {
    expect(view.draft).not.toBeNull();
    return { draftId: view.draft!.id, expectedRevision: view.draft!.baseRevision };
  }

  const activateSchool = async (which: School, view: ConfigurationView) =>
    viewOf(await schoolCall(which, 'POST', '/activate', activation(view)));
  const activatePlatform = async (view: ConfigurationView) =>
    viewOf(await consoleCall('POST', '/activate', activation(view)));
  const runtime = (which: School) =>
    runWithContext({ requestId: 'configuration-integration', tenantId: h.tenants[which] }, () =>
      h.app.get(TenantDb).run(readContentSettings),
    );

  beforeAll(async () => {
    h = await startHarness(); // PostgreSQL only: these controls require no object-storage service.
    for (const which of ['acme', 'beta'] as const) {
      const email = `owner@${which}.test`;
      await h.member(SCHOOLS[which], h.tenants[which], email);
      await h.grantRole(h.tenants[which], email, 'TENANT_OWNER');
      owners[which] = await h.signIn(SCHOOLS[which], email);
    }
    learner = await h.member(SCHOOLS.acme, h.tenants.acme, 'learner@configuration.test');
    // Authentication/TOTP has its own suite. Store only opaque token hashes and mark these fixture
    // sessions MFA-verified so the real console hook and role/reauth guards still run on every call.
    for (const role of ['PLATFORM_OWNER', 'PLATFORM_OPERATOR', 'PLATFORM_SUPPORT'] as const) {
      const user = await platformSql(
        `INSERT INTO platform_user (email, display_name, role)
         VALUES ($1, 'Configuration staff', $2::"PlatformRole") RETURNING id`,
        [`${role.toLowerCase()}@configuration.test`, role],
      );
      const { token, hash } = issueToken();
      await platformSql(
        `INSERT INTO platform_session
           (user_id, token_hash, idle_expires_at, absolute_expires_at, mfa_verified_at, reauth_at)
         VALUES ($1, $2, now() + interval '30 minutes', now() + interval '12 hours', now(), now())`,
        [user.rows[0].id, Buffer.from(hash)],
      );
      staff[role] = `${CONSOLE_COOKIE}=${token}`;
    }
  });

  beforeEach(async () => {
    for (const which of ['acme', 'beta'] as const) {
      await h.asTenant(h.tenants[which], () =>
        h.migrator.query('DELETE FROM tenant_setting WHERE key = ANY($1::text[])', [
          [...MANAGED_CONTENT_KEYS, CONTENT_DRAFT_KEY],
        ]),
      );
    }
    await platformSql('DELETE FROM platform_setting WHERE key = ANY($1::text[])', [
      [CONTENT_DEFAULTS_KEY, CONTENT_DRAFT_KEY],
    ]);
    await platformSql('UPDATE platform_session SET reauth_at = now()');
  });

  afterAll(async () => {
    await h?.close();
  });

  it('authorizes each realm and refuses learner, operator, support, and cross-school cookies', async () => {
    const request = {
      expectedRevision: (await schoolView('acme')).revision,
      values: { catalogVisibility: 'MEMBERS_ONLY' },
      lockedKeys: [],
      reason: 'Unauthorized change',
    };
    const actions = [
      ['GET', '', undefined],
      ['PUT', '/draft', request],
      [
        'POST',
        '/activate',
        { draftId: '00000000-0000-4000-8000-000000000001', expectedRevision: request.expectedRevision },
      ],
      ['POST', '/import-preview', { text: 'SCHOOL_CATALOG_VISIBILITY=MEMBERS_ONLY' }],
    ] as const;
    for (const [method, suffix, body] of actions) {
      status(await h.call(method, `${SCHOOL_PATH}${suffix}`, { host: SCHOOLS.acme, body }), 401);
      status(await h.call(method, `${CONSOLE_PATH}${suffix}`, { host: CONSOLE, body }), 401);
      status(await schoolCall('acme', method, suffix, body, learner), 403);
      status(await schoolCall('beta', method, suffix, body, owners.acme), 401);
      status(await schoolCall('acme', method, suffix, body, owners.beta), 401);
      for (const role of ['PLATFORM_OPERATOR', 'PLATFORM_SUPPORT'] as const) {
        status(await consoleCall(method, suffix, body, role), 403);
      }
    }
    status(
      await h.call('GET', CONSOLE_PATH, {
        host: CONSOLE,
        cookie: owners.acme.replace(SESSION, CONSOLE_COOKIE),
      }),
      401,
    );
    status(
      await schoolCall('acme', 'GET', '', undefined, staff.PLATFORM_OWNER.replace(CONSOLE_COOKIE, SESSION)),
      401,
    );
    for (const which of ['acme', 'beta'] as const) {
      expect(await schoolView(which)).toMatchObject({ values: {}, draft: null });
      expect(await runtime(which)).toMatchObject(DEFAULTS);
    }
  });

  it('persists drafts without changing active settings and isolates both schools through runtime reads', async () => {
    const values: ManagedContentValues = {
      catalogVisibility: 'MEMBERS_ONLY',
      courseReviewRequired: false,
      downloadsAllowedDefault: true,
    };
    const acmeDraft = await saveSchool('acme', values, 'Acme content policy');
    expect(acmeDraft).toMatchObject({ values: {}, draft: { values, stale: false } });
    expect((await schoolView('acme')).draft?.id).toBe(acmeDraft.draft?.id);
    expect(await runtime('acme')).toMatchObject(DEFAULTS);
    const settings = adminSettingsSchema.parse(
      status(
        await h.call('GET', '/api/v1/admin/settings', {
          host: SCHOOLS.acme,
          cookie: owners.acme,
        }),
      ).json(),
    );
    expect(settings.content).toMatchObject(DEFAULTS);
    const betaDraft = await saveSchool('beta', { catalogVisibility: 'PUBLIC' }, 'Beta independent policy');
    await activateSchool('beta', betaDraft);
    expect(await runtime('acme')).toMatchObject(DEFAULTS);
    const active = await activateSchool('acme', acmeDraft);
    expect(active).toMatchObject({ values, draft: null });
    expect(await runtime('acme')).toMatchObject(values);
    expect(await runtime('beta')).toMatchObject(DEFAULTS);
    const beta = await schoolView('beta');
    expect(beta.values).toEqual({ catalogVisibility: 'PUBLIC' });
    expect(beta.history.some((entry) => entry.reason === 'Acme content policy')).toBe(false);
    expect(active.history.find((entry) => entry.reason === 'Acme content policy')).toMatchObject({ values });
    for (const field of active.fields) expect(field.source).toBe('SCHOOL_OVERRIDE');
  });

  it('resolves platform defaults, school overrides, and enforced restrictions in actual content readers', async () => {
    await activateSchool(
      'acme',
      await saveSchool(
        'acme',
        {
          catalogVisibility: 'PUBLIC',
          courseReviewRequired: false,
          downloadsAllowedDefault: true,
        },
        'Store school overrides',
      ),
    );
    const platform = await activatePlatform(
      await savePlatform(
        {
          catalogVisibility: 'MEMBERS_ONLY',
          courseReviewRequired: true,
          downloadsAllowedDefault: false,
        },
        ['courseReviewRequired', 'downloadsAllowedDefault'],
        'Enforce content review and downloads',
      ),
    );
    expect(platform.lockedKeys).toEqual(['courseReviewRequired', 'downloadsAllowedDefault']);
    expect(await runtime('acme')).toMatchObject(DEFAULTS);
    expect(await runtime('beta')).toMatchObject({ ...DEFAULTS, catalogVisibility: 'MEMBERS_ONLY' });
    const acme = await schoolView('acme');
    expect(acme.fields.find((field) => field.key === 'courseReviewRequired')).toMatchObject({
      value: true,
      inheritedValue: true,
      overrideValue: false,
      locked: true,
      source: 'PLATFORM_ENFORCED',
    });
    expect(acme.fields.find((field) => field.key === 'catalogVisibility')?.source).toBe('SCHOOL_OVERRIDE');
    status(
      await schoolCall('acme', 'PUT', '/draft', {
        expectedRevision: acme.revision,
        values: { ...acme.values, courseReviewRequired: true },
        lockedKeys: [],
        reason: 'Try to alter a locked override',
      }),
      403,
    );
    status(
      await schoolCall('acme', 'PUT', '/draft', {
        expectedRevision: acme.revision,
        values: acme.values,
        lockedKeys: ['catalogVisibility'],
        reason: 'School cannot enforce platform defaults',
      }),
      403,
    );
    status(
      await h.call('PATCH', '/api/v1/admin/settings', {
        host: SCHOOLS.acme,
        cookie: owners.acme,
        body: { courseReviewRequired: false, reason: 'Legacy route cannot bypass restrictions' },
      }),
      403,
    );
    expect((await schoolView('acme')).values).toEqual(acme.values);
    // Removing dormant overrides remains possible while the platform restriction stays active.
    await activateSchool('acme', await saveSchool('acme', {}, 'Reset school overrides to platform'));
    expect((await schoolView('acme')).values).toEqual({});
    expect(await runtime('acme')).toMatchObject({ ...DEFAULTS, catalogVisibility: 'MEMBERS_ONLY' });
    expect((await platformView()).revision).toBe(platform.revision);
  });

  it('refuses replaced draft ids and stale revisions without changing active settings', async () => {
    const older = await saveSchool('acme', { catalogVisibility: 'MEMBERS_ONLY' }, 'First saved draft');
    const newer = await saveSchool('acme', { downloadsAllowedDefault: true }, 'Replacement saved draft');
    expect(newer.draft?.id).not.toBe(older.draft?.id);
    status(await schoolCall('acme', 'POST', '/activate', activation(older)), 409);
    expect(await runtime('acme')).toMatchObject(DEFAULTS);
    expect((await schoolView('acme')).draft?.id).toBe(newer.draft?.id);
    await activatePlatform(
      await savePlatform({ courseReviewRequired: false }, [], 'Change inherited platform policy'),
    );
    const before = await schoolView('acme');
    expect(before.draft?.stale).toBe(true);
    status(await schoolCall('acme', 'POST', '/activate', activation(newer)), 409);
    status(
      await schoolCall('acme', 'PUT', '/draft', {
        expectedRevision: newer.revision,
        values: { catalogVisibility: 'MEMBERS_ONLY' },
        lockedKeys: [],
        reason: 'Save using an outdated revision',
      }),
      409,
    );
    const after = await schoolView('acme');
    expect(after).toMatchObject({
      revision: before.revision,
      values: before.values,
      draft: { id: newer.draft!.id },
    });
    expect(await runtime('acme')).toMatchObject({ ...DEFAULTS, courseReviewRequired: false });
    // A reviewed replacement uses the new revision and can then activate normally.
    await activateSchool(
      'acme',
      await saveSchool('acme', { downloadsAllowedDefault: true }, 'Review after platform change'),
    );
    expect(await runtime('acme')).toMatchObject({
      ...DEFAULTS,
      courseReviewRequired: false,
      downloadsAllowedDefault: true,
    });
  });

  it('restores an activation through a new reviewable draft and deletes override rows on reset', async () => {
    const first: ManagedContentValues = { catalogVisibility: 'MEMBERS_ONLY', downloadsAllowedDefault: true };
    await activateSchool('acme', await saveSchool('acme', first, 'Historical policy to restore'));
    await activateSchool(
      'acme',
      await saveSchool('acme', { catalogVisibility: 'PUBLIC' }, 'Temporary public policy'),
    );
    const current = await schoolView('acme');
    const snapshot = current.history.find((entry) => entry.reason === 'Historical policy to restore');
    expect(snapshot?.values).toEqual(first);
    const restoredDraft = await saveSchool('acme', snapshot!.values, 'Restore historical content policy');
    expect(restoredDraft.values).toEqual({ catalogVisibility: 'PUBLIC' });
    expect(await runtime('acme')).toMatchObject(DEFAULTS);
    const restored = await activateSchool('acme', restoredDraft);
    expect(
      restored.history.find((entry) => entry.reason === 'Restore historical content policy'),
    ).toMatchObject({ values: first });
    expect(await runtime('acme')).toMatchObject({ ...DEFAULTS, ...first });
    await activateSchool('acme', await saveSchool('acme', {}, 'Return to inherited defaults'));
    expect(await runtime('acme')).toMatchObject(DEFAULTS);
    const rows = await h.asTenant(h.tenants.acme, () =>
      h.migrator.query('SELECT key FROM tenant_setting WHERE key = ANY($1::text[])', [
        [...MANAGED_CONTENT_KEYS, CONTENT_DRAFT_KEY],
      ]),
    );
    expect(rows.rows).toEqual([]);
  });

  it('keeps explicit legacy overrides equal to inherited defaults when platform defaults later change', async () => {
    const legacy = await h.call('PATCH', '/api/v1/admin/settings', {
      host: SCHOOLS.acme,
      cookie: owners.acme,
      body: { courseReviewRequired: true, reason: 'Acme explicitly retains review' },
    });
    status(legacy);
    expect((await schoolView('acme')).values).toEqual({ courseReviewRequired: true });
    await activatePlatform(await savePlatform({ courseReviewRequired: false }, [], 'Default review off'));
    expect((await runtime('acme')).courseReviewRequired).toBe(true);
    expect((await runtime('beta')).courseReviewRequired).toBe(false);
  });

  it('requires fresh console reauthentication for activation and preserves the draft on refusal', async () => {
    const draft = await savePlatform(
      { catalogVisibility: 'MEMBERS_ONLY' },
      [],
      'Require console reauthentication',
    );
    expect(await runtime('beta')).toMatchObject(DEFAULTS);
    await platformSql(`UPDATE platform_session SET reauth_at = now() - interval '1 hour'`);
    const rejected = status(await consoleCall('POST', '/activate', activation(draft)), 403);
    expect(rejected.json().code).toBe('REAUTH_REQUIRED');
    expect(await platformView()).toMatchObject({ values: {}, draft: { id: draft.draft!.id } });
    expect(await runtime('beta')).toMatchObject(DEFAULTS);
    await platformSql('UPDATE platform_session SET reauth_at = now()');
    await activatePlatform(draft);
    expect(await runtime('beta')).toMatchObject({ ...DEFAULTS, catalogVisibility: 'MEMBERS_ONLY' });
  });

  it('previews only typed allowlisted import values and never echoes or persists rejected credentials', async () => {
    const before = await schoolView('acme');
    const platformBefore = await platformView();
    const text =
      '# Content settings only\nexport SCHOOL_CATALOG_VISIBILITY="MEMBERS_ONLY"\nSCHOOL_COURSE_REVIEW_REQUIRED=false\nSCHOOL_DOWNLOADS_ALLOWED_DEFAULT=true\n';
    const preview = configurationImportPreviewSchema.parse(
      status(await schoolCall('acme', 'POST', '/import-preview', { text })).json(),
    );
    expect(preview.values).toEqual({
      catalogVisibility: 'MEMBERS_ONLY',
      courseReviewRequired: false,
      downloadsAllowedDefault: true,
    });
    expect(preview.entries).toHaveLength(3);
    for (const invalid of [
      'SCHOOL_COURSE_REVIEW_REQUIRED=1',
      'SCHOOL_CATALOG_VISIBILITY=EVERYONE',
      'SCHOOL_DOWNLOADS_ALLOWED_DEFAULT=true\nSCHOOL_DOWNLOADS_ALLOWED_DEFAULT=false',
    ]) {
      status(await schoolCall('acme', 'POST', '/import-preview', { text: invalid }), 422);
    }
    const secret = 'configuration-import-secret-must-never-be-persisted';
    for (const key of ['DATABASE_URL_APP', 'S3_SECRET_ACCESS_KEY', 'SMTP_PASSWORD', 'PAYMENT_API_KEY']) {
      const payload = { text: `${key}=${secret}` };
      for (const response of [
        await schoolCall('acme', 'POST', '/import-preview', payload),
        await consoleCall('POST', '/import-preview', payload),
      ]) {
        status(response, 422);
        expect(response.json().code).toBe('VALIDATION_FAILED');
        expect(response.body).not.toContain(secret);
        expect(response.body).toContain(key);
      }
    }
    expect(await schoolView('acme')).toEqual(before);
    expect(await platformView()).toEqual(platformBefore);
    expect(await runtime('acme')).toMatchObject(DEFAULTS);
    const tenantLeaks = await h.asTenant(h.tenants.acme, () =>
      h.migrator.query(
        `SELECT key FROM tenant_setting WHERE value::text LIKE $1
       UNION ALL SELECT action FROM audit_log WHERE coalesce("before"::text, '') LIKE $1 OR coalesce("after"::text, '') LIKE $1`,
        [`%${secret}%`],
      ),
    );
    const platformLeaks = await platformSql(
      `SELECT key FROM platform_setting WHERE value::text LIKE $1
       UNION ALL SELECT action FROM platform_audit_log WHERE coalesce("before"::text, '') LIKE $1 OR coalesce("after"::text, '') LIKE $1`,
      [`%${secret}%`],
    );
    expect(tenantLeaks.rows).toEqual([]);
    expect(platformLeaks.rows).toEqual([]);
  });
});
