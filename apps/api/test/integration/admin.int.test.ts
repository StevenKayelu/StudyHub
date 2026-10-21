import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createExportHandler, createPurgeHandler, EXPORT_JOB, readZip } from '../../src/modules/admin';
import {
  BOOTSTRAP_STORAGE_LOCATION_ID,
  createLogger,
  DEV_IDENTITY_ENCRYPTION_KEY,
  hashPassword,
  OBJECT_STORAGE,
  type ObjectStorage,
  PrismaService,
  runWithContext,
  STORAGE_LOCATIONS,
  type StorageLocations,
  SecretBox,
  timeStep,
  totpCode,
} from '../../src/modules/platform';
import { cookieFrom, type Harness, PASSWORD, SCHOOLS, startHarness } from '../setup/school-harness';
import { tenantOwnedTables } from '../setup/tenancy-checks';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses

const { acme: ACME, beta: BETA } = SCHOOLS;
const CONSOLE = 'console.localhost';
const CONSOLE_COOKIE = '__Host-sh_console';
const SUPPORT_COOKIE = '__Host-sh_support';
const today = new Date().toISOString().slice(0, 10);
const period = today.slice(0, 7);

const ALL_FEATURES = {
  paidCourses: true,
  practiceMode: true,
  quizAnalytics: true,
  instructorApplications: true,
  instructorRevenueShare: true,
  publicCatalog: true,
  whiteLabel: true,
  dataExport: true,
};
const LIMITS = {
  maxActiveLearners: 500,
  maxInstructors: 20,
  maxAdmins: 5,
  storageGb: 50,
  videoMinutesPerMonth: 10_000,
  hardBlockVideo: false,
  maxDocumentMb: 100,
  maxVideoGb: 4,
};

describe('tenant administration, white-label and platform console (M9)', () => {
  let h: Harness;
  let storage: ObjectStorage;
  let prisma: PrismaService;
  const box = new SecretBox(DEV_IDENTITY_ENCRYPTION_KEY);
  const silent = createLogger({ level: 'silent' });
  const cookies: Record<string, string> = {};
  const consoleCookies: Record<string, string> = {};
  const tenants: Record<string, string> = {};
  /** Recorded sales and refunds of Acme this month (W8 statement fixture). */
  const acmeMoney = { sales: 0, refunds: 0 };
  let acmeAccount = '';
  let acmeCourse = '';

  // --- helpers ---------------------------------------------------------------------------------------

  const ok = async (response: Awaited<ReturnType<Harness['call']>>, status = 200): Promise<Json> => {
    expect(response.statusCode, response.body).toBe(status);
    return response.body === '' ? {} : response.json();
  };
  const code = (response: Awaited<ReturnType<Harness['call']>>) => (response.json() as Json).code;
  const school = (
    method: Parameters<Harness['call']>[0],
    url: string,
    host: string,
    cookie?: string,
    body?: unknown,
  ) => h.call(method, url, { host, cookie, body });
  const consoleCall = (method: Parameters<Harness['call']>[0], url: string, staff: string, body?: unknown) =>
    h.call(method, url, { host: CONSOLE, cookie: consoleCookies[staff], body });
  const sql = (tenantId: string, text: string, params: unknown[] = []) =>
    h.asTenant(tenantId, () => h.migrator.query(text, params));
  async function platformSql(text: string, params: unknown[] = []) {
    await h.migrator.query('BEGIN');
    try {
      await h.migrator.query(`SELECT set_config('app.realm', 'platform', true)`);
      const result = await h.migrator.query(text, params);
      await h.migrator.query('COMMIT');
      return result;
    } catch (error) {
      await h.migrator.query('ROLLBACK');
      throw error;
    }
  }
  const membershipOf = async (tenantId: string, email: string) =>
    (
      await sql(
        tenantId,
        `SELECT m.id FROM tenant_membership m JOIN user_account a ON a.id = m.user_id WHERE a.email = $1`,
        [email],
      )
    ).rows[0].id as string;

  /** Queued emails of a school for a template (and recipient), with their sealed variables opened. */
  async function emails(
    tenantId: string,
    template: string,
    to?: string,
  ): Promise<{ to: string; vars: Json }[]> {
    const { rows } = await sql(
      tenantId,
      `SELECT payload FROM outbox WHERE topic = 'email.send' AND payload->>'template' = $1 ORDER BY id`,
      [template],
    );
    return rows
      .map((row: Json) => ({
        to: row.payload.to as string,
        vars: JSON.parse(box.openText(row.payload.sealed, `email:${tenantId}:${row.payload.to}`)) as Json,
      }))
      .filter((email: { to: string }) => to === undefined || email.to === to);
  }
  const tokenFrom = (link: string) => /#token=(.+)$/.exec(link)![1]!;

  async function createStaff(email: string, role: string): Promise<void> {
    const hash = await hashPassword(PASSWORD);
    const { rows } = await platformSql(
      `INSERT INTO platform_user (email, display_name, role) VALUES ($1, $2, $3::"PlatformRole") RETURNING id`,
      [email, `Staff ${role.toLowerCase()}`, role],
    );
    await platformSql(`INSERT INTO platform_credential (user_id, password_hash) VALUES ($1, $2)`, [
      rows[0].id,
      hash,
    ]);
  }
  async function consoleSession(email: string): Promise<string> {
    const signedIn = await h.call('POST', '/console/auth/sign-in', {
      host: CONSOLE,
      body: { email, password: PASSWORD },
    });
    const cookie = cookieFrom(signedIn.headers['set-cookie'], CONSOLE_COOKIE)!;
    const setup = await h.call('POST', '/console/auth/totp/setup', { host: CONSOLE, cookie });
    const secret = Buffer.from(base32Decode(setup.json().secret));
    await ok(
      await h.call('POST', '/console/auth/totp/enable', {
        host: CONSOLE,
        cookie,
        body: { code: totpCode(secret, timeStep()) },
      }),
    );
    return cookie;
  }
  /** Sensitive console actions need a fresh re-authentication (04 §17.5); tests renew it directly. */
  const freshReauth = () => platformSql(`UPDATE platform_session SET reauth_at = now()`);

  /** Runs a school's queued jobs of one topic through a handler, in that school's context. */
  async function runJobs(
    tenantId: string,
    topic: string,
    handler: (envelope: Json, logger: typeof silent) => Promise<unknown>,
  ) {
    const { rows } = await sql(
      tenantId,
      `SELECT id, payload FROM outbox WHERE topic = $1 AND dispatched_at IS NULL ORDER BY id`,
      [topic],
    );
    for (const row of rows) {
      await sql(tenantId, `UPDATE outbox SET dispatched_at = now() WHERE id = $1`, [row.id]);
      await runWithContext({ requestId: `test_${row.id}`, tenantId }, () =>
        handler({ type: topic, tenantId, payload: row.payload, requestId: 'test' }, silent),
      );
    }
    return rows.length;
  }
  async function readObject(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of (await storage.stream(key)) as Readable)
      chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }

  /** A paid (and optionally refunded) Acme payment on its fake account, confirmed now. */
  async function acmeSale(
    amount: number,
    options: { reference?: string; refund?: boolean } = {},
  ): Promise<string> {
    const buyer = await membershipOf(tenants.acme!, 'l1@example.com');
    const order = (
      await sql(
        tenants.acme!,
        `INSERT INTO "order" (tenant_id, membership_id, status, currency, total_minor, expires_at, paid_at)
         VALUES ($1, $2, $3, 'ZMW', $4, now() + interval '1 hour', now()) RETURNING id`,
        [tenants.acme, buyer, options.refund === true ? 'REFUNDED' : 'PAID', amount],
      )
    ).rows[0].id;
    const payment = (
      await sql(
        tenants.acme!,
        `INSERT INTO payment (tenant_id, order_id, payment_account_id, provider, method, amount_minor, currency, status,
           confirmed_at, reference)
         VALUES ($1, $2, $3, 'fake', 'CARD', $4, 'ZMW', $5, now(), $6) RETURNING id`,
        [
          tenants.acme,
          order,
          acmeAccount,
          amount,
          options.refund === true ? 'REFUNDED' : 'SUCCEEDED',
          options.reference ?? randomUUID(),
        ],
      )
    ).rows[0].id;
    acmeMoney.sales += amount;
    if (options.refund === true) {
      await sql(
        tenants.acme!,
        `INSERT INTO refund (tenant_id, order_id, payment_id, amount_minor, currency, reason, mode, status, manual_reference,
           requested_by, completed_at)
         VALUES ($1, $2, $3, $4, 'ZMW', 'Fixture refund', 'MANUAL', 'SUCCEEDED', 'REF-1', $5, now())`,
        [tenants.acme, order, payment, amount, buyer],
      );
      acmeMoney.refunds += amount;
    }
    return payment as string;
  }

  beforeAll(async () => {
    h = await startHarness({ objectStore: true });
    storage = h.app.get<ObjectStorage>(OBJECT_STORAGE);
    prisma = h.app.get(PrismaService);
    tenants.acme = h.tenants.acme;
    tenants.beta = h.tenants.beta;

    for (const [email, role] of [
      ['owner@platform.test', 'PLATFORM_OWNER'],
      ['operator@platform.test', 'PLATFORM_OPERATOR'],
      ['support@platform.test', 'PLATFORM_SUPPORT'],
    ] as const) {
      await createStaff(email, role);
      consoleCookies[role] = await consoleSession(email);
    }

    for (const [email, role, name] of [
      ['owner@acme.test', 'TENANT_OWNER', 'Olu Owner'],
      ['admin@acme.test', 'TENANT_ADMIN', 'Ada Admin'],
      ['tutor@acme.test', 'INSTRUCTOR', 'Tiko Phiri'],
    ] as const) {
      await h.member(ACME, h.tenants.acme, email, name);
      await h.grantRole(h.tenants.acme, email, role);
      cookies[email] = await h.signIn(ACME, email);
    }
    for (const n of [1, 2])
      cookies[`l${n}@example.com`] = await h.member(
        ACME,
        h.tenants.acme,
        `l${n}@example.com`,
        `Learner ${n}`,
      );
    await h.member(BETA, h.tenants.beta, 'owner@beta.test', 'Beth Owner');
    await h.grantRole(h.tenants.beta, 'owner@beta.test', 'TENANT_OWNER');
    cookies['owner@beta.test'] = await h.signIn(BETA, 'owner@beta.test');
    cookies['b1@example.com'] = await h.member(BETA, h.tenants.beta, 'b1@example.com', 'Beta Learner');

    // Plans, made through the console (S-C06).
    await freshReauth();
    await ok(
      await consoleCall('POST', '/console/plans', 'PLATFORM_OWNER', {
        code: 'starter',
        name: 'Starter',
        features: { ...ALL_FEATURES, practiceMode: false, whiteLabel: false, dataExport: false },
        limits: { ...LIMITS, maxInstructors: 1, maxActiveLearners: 3 },
        pricing: { subscriptionFeeMinor: 20_000, currency: 'ZMW', platformCommissionBps: 0 },
      }),
      201,
    );
    await ok(
      await consoleCall('POST', '/console/plans', 'PLATFORM_OWNER', {
        code: 'school-standard',
        name: 'School standard',
        features: ALL_FEATURES,
        limits: LIMITS,
        pricing: { subscriptionFeeMinor: 50_000, currency: 'ZMW', platformCommissionBps: 500 },
      }),
      201,
    );
    for (const id of [h.tenants.acme, h.tenants.beta]) {
      await ok(
        await consoleCall('PATCH', `/console/tenants/${id}`, 'PLATFORM_OWNER', {
          planCode: 'school-standard',
          reason: 'Launch plan',
        }),
        204,
      );
    }

    // Acme's fake payment account (FULL: transaction list API) and a published course.
    const owner = cookies['owner@acme.test']!;
    const created = await ok(
      await school('POST', '/api/v1/admin/payment-accounts', ACME, owner, {
        provider: 'fake',
        label: 'Main',
        credentials: {
          merchantId: 'acme-m-0001',
          apiKey: 'fixture-acme-api-key-1234',
          webhookSecret: 'fixture-acme-webhook-0123456789',
          profile: 'FULL',
        },
      }),
      201,
    );
    await ok(await school('POST', `/api/v1/admin/payment-accounts/${created.id}/test`, ACME, owner));
    await ok(await school('POST', `/api/v1/admin/payment-accounts/${created.id}/activate`, ACME, owner));
    acmeAccount = created.id;
    acmeCourse = (
      await sql(
        h.tenants.acme,
        `INSERT INTO course (tenant_id, owner_membership_id, slug, title, status, first_published_at, published_at, price_minor, currency)
         VALUES ($1, $2, 'stats', 'Statistics', 'PUBLISHED', now(), now(), 0, 'ZMW') RETURNING id`,
        [h.tenants.acme, await membershipOf(h.tenants.acme, 'tutor@acme.test')],
      )
    ).rows[0].id;
  }, 300_000);

  afterAll(async () => {
    await h?.close();
  });

  // -------------------------------------------------------------------------------------------------
  // AC 1: operator provisions → owner brands, configures, invites and goes live with no DB access
  // -------------------------------------------------------------------------------------------------

  it('AC 1 (F37, F39, F41, F42, S-AD11): provision → accept → brand → configure → invite → go live', async () => {
    // Slug rules (BR-50).
    expect(
      code(
        await consoleCall('POST', '/console/tenants', 'PLATFORM_OPERATOR', {
          name: 'Admin',
          kind: 'SCHOOL',
          slug: 'admin',
          planCode: 'starter',
          ownerEmail: 'x@example.com',
        }),
      ),
    ).toBe('SLUG_RESERVED');
    expect(
      code(
        await consoleCall('POST', '/console/tenants', 'PLATFORM_OPERATOR', {
          name: 'Acme 2',
          kind: 'SCHOOL',
          slug: 'acme',
          planCode: 'starter',
          ownerEmail: 'x@example.com',
        }),
      ),
    ).toBe('SLUG_TAKEN');
    expect(
      (
        await consoleCall('POST', '/console/tenants', 'PLATFORM_SUPPORT', {
          name: 'Nope',
          kind: 'SCHOOL',
          slug: 'nope-school',
          planCode: 'starter',
          ownerEmail: 'x@example.com',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await consoleCall('GET', '/console/tenants/slug-availability?slug=gamma', 'PLATFORM_OPERATOR')).json(),
    ).toEqual({ slug: 'gamma', available: true, problem: null });

    const created = await ok(
      await consoleCall('POST', '/console/tenants', 'PLATFORM_OPERATOR', {
        name: 'Gamma Tutors',
        kind: 'TUTORING_BUSINESS',
        slug: 'gamma',
        planCode: 'starter',
        ownerEmail: 'owner@gamma.test',
      }),
      201,
    );
    expect(created).toMatchObject({
      status: 'PROVISIONING',
      primaryHost: 'gamma.localhost',
      ownerInvitation: { email: 'owner@gamma.test' },
    });
    tenants.gamma = created.id;
    const GAMMA = 'gamma.localhost';

    // Reachable at once, "coming soon": visitors can't sign up.
    expect((await ok(await school('GET', '/api/v1/tenant', GAMMA))).status).toBe('PROVISIONING');
    expect(
      code(
        await school('POST', '/api/v1/auth/register', GAMMA, undefined, {
          displayName: 'V',
          email: 'v@example.com',
          password: PASSWORD,
          acceptTerms: true,
        }),
      ),
    ).toBe('REGISTRATION_CLOSED');

    // The owner accepts the invitation and creates their account (BR-67).
    const [invitation] = await emails(tenants.gamma!, 'invitation', 'owner@gamma.test');
    const accepted = await school('POST', '/api/v1/invitations/accept', GAMMA, undefined, {
      token: tokenFrom(invitation!.vars.link),
      password: PASSWORD,
      displayName: 'Grace Owner',
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const owner = cookieFrom(accepted.headers['set-cookie'])!;
    cookies['owner@gamma.test'] = owner;
    expect((await ok(await school('GET', '/api/v1/admin/onboarding', GAMMA, owner))).canGoLive).toBe(false);
    expect(code(await school('POST', '/api/v1/admin/onboarding/go-live', GAMMA, owner))).toBe(
      'ONBOARDING_INCOMPLETE',
    );

    // Branding (F39): contrast is enforced (AC 1), then publish, version history and rollback.
    const yellow = await ok(
      await school('POST', '/api/v1/admin/branding/validate-colour', GAMMA, owner, { accentHex: '#ffff00' }),
    );
    expect(yellow.ok).toBe(false);
    expect(yellow.suggestions.length).toBeGreaterThan(0);
    const editor = await ok(await school('GET', '/api/v1/admin/branding', GAMMA, owner));
    const draft = {
      ...editor.draft,
      displayName: 'Gamma Tutors Ltd',
      accentHex: '#ffff00',
      fontPreset: 'HUMANIST',
      homeLayout: { ...editor.draft.homeLayout, heroTitle: { en: 'Learn with Gamma' } },
      footerLinks: [{ label: { en: 'Contact' }, url: '/contact' }],
      supportEmail: 'help@gamma.test',
    };
    expect(code(await school('PUT', '/api/v1/admin/branding/draft', GAMMA, owner, draft))).toBe(
      'COLOUR_NOT_COMPLIANT',
    );
    expect(
      code(
        await school('PUT', '/api/v1/admin/branding/draft', GAMMA, owner, {
          ...draft,
          accentHex: '#0b7285',
          showPoweredBy: false,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    await ok(
      await school('PUT', '/api/v1/admin/branding/draft', GAMMA, owner, { ...draft, accentHex: '#0b7285' }),
      204,
    );
    // The live site doesn't change until publish.
    expect((await ok(await school('GET', '/api/v1/tenant', GAMMA))).branding.accentHex).toBeNull();
    expect(await ok(await school('POST', '/api/v1/admin/branding/publish', GAMMA, owner))).toEqual({
      version: 2,
    });
    const live = await ok(await school('GET', '/api/v1/tenant', GAMMA));
    expect(live.branding).toMatchObject({
      version: 2,
      displayName: 'Gamma Tutors Ltd',
      accentHex: '#0b7285',
      fontPreset: 'HUMANIST',
      supportEmail: 'help@gamma.test',
      homeLayout: { heroTitle: { en: 'Learn with Gamma' } },
    });
    expect(await ok(await school('POST', '/api/v1/admin/branding/rollback/1', GAMMA, owner))).toEqual({
      version: 3,
    });
    expect((await ok(await school('GET', '/api/v1/tenant', GAMMA))).branding.accentHex).toBeNull();
    await ok(await school('POST', '/api/v1/admin/branding/rollback/2', GAMMA, owner));
    expect((await ok(await school('GET', '/api/v1/tenant', GAMMA))).branding.accentHex).toBe('#0b7285');
    // Another school's branding is untouched (F39 AC 2).
    expect((await ok(await school('GET', '/api/v1/tenant', BETA))).branding.accentHex).toBeNull();

    // Settings (F41): every group through one endpoint, validated and audited.
    expect(
      code(
        await school('PATCH', '/api/v1/admin/settings', GAMMA, owner, {
          learnerRegistrationMode: 'EMAIL_DOMAIN',
          reason: 'Members only',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      code(
        await school('PATCH', '/api/v1/admin/settings', GAMMA, owner, {
          maxDocumentMb: 400,
          reason: 'Big files',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const settings = await ok(
      await school('PATCH', '/api/v1/admin/settings', GAMMA, owner, {
        learnerRegistrationMode: 'EMAIL_DOMAIN',
        allowedEmailDomains: ['gamma.test'],
        courseReviewRequired: false,
        legalPages: { terms: { en: 'Our terms.' }, privacy: { en: 'Our privacy notice.' } },
        reason: 'Initial setup',
      }),
    );
    expect(settings.general).toMatchObject({
      learnerRegistrationMode: 'EMAIL_DOMAIN',
      allowedEmailDomains: ['gamma.test'],
    });
    expect(settings.lastChange).toMatchObject({ by: 'Grace Owner', reason: 'Initial setup' });
    expect((await ok(await school('GET', '/api/v1/legal/terms', GAMMA))).body).toBe('Our terms.');

    // Team (F42) within the plan's limits (BR-49): starter allows one instructor.
    await ok(
      await school('POST', '/api/v1/admin/invitations', GAMMA, owner, {
        email: 'tutor@gamma.test',
        role: 'INSTRUCTOR',
      }),
      201,
    );
    const second = await school('POST', '/api/v1/admin/invitations', GAMMA, owner, {
      email: 'tutor2@gamma.test',
      role: 'INSTRUCTOR',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'LIMIT_REACHED', limit: 'instructors', max: 1 });
    expect((await emails(tenants.gamma!, 'usage-alert', 'owner@gamma.test')).length).toBe(1);

    // Go live (S-AD11): the required steps are done now.
    const onboarding = await ok(await school('GET', '/api/v1/admin/onboarding', GAMMA, owner));
    expect(onboarding.steps.filter((step: Json) => step.required).every((step: Json) => step.done)).toBe(
      true,
    );
    await ok(await school('POST', '/api/v1/admin/onboarding/go-live', GAMMA, owner), 204);
    expect((await ok(await school('GET', '/api/v1/tenant', GAMMA))).status).toBe('ACTIVE');
    const wrongDomain = await school('POST', '/api/v1/auth/register', GAMMA, undefined, {
      displayName: 'V',
      email: 'v@example.com',
      password: PASSWORD,
      acceptTerms: true,
    });
    expect(wrongDomain.statusCode).toBe(422);

    // The school's audit log tells the story; the console sees the result and only metadata.
    const audit = await ok(await school('GET', '/api/v1/admin/audit-log', GAMMA, owner));
    const actions = audit.entries.map((entry: Json) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'tenant.created',
        'invitation.accepted',
        'branding.published',
        'branding.rolled_back',
        'settings.updated',
        'invitation.created',
        'tenant.activated',
      ]),
    );
    expect(audit.entries.find((entry: Json) => entry.action === 'branding.published').actorName).toBe(
      'Grace Owner',
    );
    const detail = await ok(
      await consoleCall('GET', `/console/tenants/${tenants.gamma}`, 'PLATFORM_SUPPORT'),
    );
    expect(detail.tenant).toMatchObject({ status: 'ACTIVE', ownerContactEmail: 'owner@gamma.test' });
    expect(detail.plan).toEqual({ code: 'starter', name: 'Starter' });
    expect(JSON.stringify(detail)).not.toContain('Grace Owner');
  });

  it('F40: features follow the plan, the school’s switch and platform overrides; settings never cross schools (F41 AC 1)', async () => {
    const GAMMA = 'gamma.localhost';
    const owner = cookies['owner@gamma.test']!;
    const practice = async () =>
      (await ok(await school('GET', '/api/v1/admin/features', GAMMA, owner))).features.find(
        (f: Json) => f.key === 'practiceMode',
      );
    expect(await practice()).toMatchObject({ available: false, planGrants: false, effective: false });
    expect(
      code(await school('PUT', '/api/v1/admin/features/practiceMode', GAMMA, owner, { enabled: true })),
    ).toBe('FEATURE_NOT_ENABLED');

    // Overrides are sensitive: they need a fresh re-authentication.
    await platformSql(`UPDATE platform_session SET reauth_at = now() - interval '1 hour'`);
    expect(
      code(
        await consoleCall(
          'PUT',
          `/console/tenants/${tenants.gamma}/features/practiceMode`,
          'PLATFORM_OPERATOR',
          { override: 'GRANT', reason: 'Pilot' },
        ),
      ),
    ).toBe('REAUTH_REQUIRED');
    await freshReauth();
    await ok(
      await consoleCall(
        'PUT',
        `/console/tenants/${tenants.gamma}/features/practiceMode`,
        'PLATFORM_OPERATOR',
        { override: 'GRANT', reason: 'Pilot' },
      ),
      204,
    );
    expect(await practice()).toMatchObject({ available: true, override: 'GRANT', effective: true });
    expect((await ok(await school('GET', '/api/v1/tenant', GAMMA))).features.practiceMode).toBe(true);
    // The school switches it off; data is kept and it can come back (F40 AC 1, AC 2).
    await ok(
      await school('PUT', '/api/v1/admin/features/practiceMode', GAMMA, owner, { enabled: false }),
      204,
    );
    expect((await ok(await school('GET', '/api/v1/tenant', GAMMA))).features.practiceMode).toBe(false);
    await ok(
      await school('PUT', '/api/v1/admin/features/practiceMode', GAMMA, owner, { enabled: true }),
      204,
    );

    // F41 AC 1: Acme's change has no effect on Beta.
    await ok(
      await school('PATCH', '/api/v1/admin/settings', ACME, cookies['owner@acme.test'], {
        courseReviewRequired: false,
        orderExpiryMinutes: 45,
        reason: 'Faster',
      }),
    );
    const beta = await ok(await school('GET', '/api/v1/admin/settings', BETA, cookies['owner@beta.test']));
    expect(beta.content.courseReviewRequired).toBe(true);
    expect(beta.commerce.orderExpiryMinutes).toBe(30);
    // Languages (BR-61): only English ships; the default must be enabled.
    expect(
      code(
        await school('PUT', '/api/v1/admin/locales', ACME, cookies['owner@acme.test'], {
          defaultLocale: 'en',
          enabledLocales: ['en'],
          timeZone: 'Mars/Base',
          reason: 'x y z',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    await ok(
      await school('PUT', '/api/v1/admin/locales', ACME, cookies['owner@acme.test'], {
        defaultLocale: 'en',
        enabledLocales: ['en'],
        timeZone: 'Africa/Harare',
        reason: 'Head office',
      }),
      204,
    );
    expect((await ok(await school('GET', '/api/v1/tenant', ACME))).locales.timeZone).toBe('Africa/Harare');
  });

  it('feature dependencies, unbuilt capabilities and school isolation are enforced on direct requests', async () => {
    const owner = cookies['owner@acme.test']!;
    const switchFeature = (key: string, enabled: boolean) =>
      school('PUT', `/api/v1/admin/features/${key}`, ACME, owner, { enabled });
    expect(
      code(
        await school('PUT', '/api/v1/admin/features/publicCatalog', ACME, cookies['l1@example.com'], {
          enabled: false,
        }),
      ),
    ).toBe('FORBIDDEN');
    await freshReauth();
    for (const key of ['customDomain', 'certificates']) {
      expect(code(await switchFeature(key, true))).toBe('FEATURE_NOT_ENABLED');
      expect(
        code(
          await consoleCall('PUT', `/console/tenants/${tenants.acme}/features/${key}`, 'PLATFORM_OWNER', {
            override: 'GRANT',
            reason: 'Unbuilt capability test',
          }),
        ),
      ).toBe('FEATURE_NOT_ENABLED');
    }
    await ok(await switchFeature('instructorRevenueShare', true), 204);
    try {
      expect(code(await switchFeature('paidCourses', false))).toBe('VALIDATION_FAILED');
      expect(
        code(
          await consoleCall(
            'PUT',
            `/console/tenants/${tenants.acme}/features/paidCourses`,
            'PLATFORM_OPERATOR',
            {
              override: 'REVOKE',
              reason: 'Dependency test',
            },
          ),
        ),
      ).toBe('VALIDATION_FAILED');
      await ok(await switchFeature('instructorRevenueShare', false), 204);
      await ok(await switchFeature('paidCourses', false), 204);
      expect(code(await switchFeature('instructorRevenueShare', true))).toBe('VALIDATION_FAILED');
      expect(
        code(
          await consoleCall(
            'PUT',
            `/console/tenants/${tenants.acme}/features/instructorRevenueShare`,
            'PLATFORM_OPERATOR',
            {
              override: 'GRANT',
              reason: 'Dependency test',
            },
          ),
        ),
      ).toBe('VALIDATION_FAILED');
      expect((await ok(await school('GET', '/api/v1/tenant', ACME))).features.paidCourses).toBe(false);
      expect((await ok(await school('GET', '/api/v1/tenant', BETA))).features.paidCourses).toBe(true);
    } finally {
      await ok(await switchFeature('instructorRevenueShare', false), 204);
      await ok(await switchFeature('paidCourses', true), 204);
    }
  });

  it('revoking whiteLabel restores the badge without discarding published branding', async () => {
    const owner = cookies['owner@acme.test']!;
    const editor = await ok(await school('GET', '/api/v1/admin/branding', ACME, owner));
    await ok(
      await school('PUT', '/api/v1/admin/branding/draft', ACME, owner, {
        ...editor.draft,
        showPoweredBy: false,
      }),
      204,
    );
    await ok(await school('POST', '/api/v1/admin/branding/publish', ACME, owner));
    expect((await ok(await school('GET', '/api/v1/tenant', ACME))).branding.showPoweredBy).toBe(false);
    await ok(await school('PUT', '/api/v1/admin/features/whiteLabel', ACME, owner, { enabled: false }), 204);
    try {
      expect((await ok(await school('GET', '/api/v1/tenant', ACME))).branding.showPoweredBy).toBe(true);
      expect((await ok(await school('GET', '/api/v1/admin/branding', ACME, owner))).draft.showPoweredBy).toBe(
        false,
      );
    } finally {
      await ok(await school('PUT', '/api/v1/admin/features/whiteLabel', ACME, owner, { enabled: true }), 204);
      await ok(await school('PUT', '/api/v1/admin/branding/draft', ACME, owner, editor.draft), 204);
      await ok(await school('POST', '/api/v1/admin/branding/publish', ACME, owner));
    }
  });

  it('F37: suspension makes the school read-only and tells its owners; lifecycle needs re-authentication', async () => {
    const GAMMA = 'gamma.localhost';
    await freshReauth();
    expect(
      code(
        await consoleCall('POST', `/console/tenants/${tenants.gamma}/activate`, 'PLATFORM_OPERATOR', {
          reason: 'Again',
        }),
      ),
    ).toBe('INVALID_STATE');
    await ok(
      await consoleCall('POST', `/console/tenants/${tenants.gamma}/suspend`, 'PLATFORM_OPERATOR', {
        reason: 'Unpaid invoice',
      }),
    );
    expect((await ok(await school('GET', '/api/v1/tenant', GAMMA))).status).toBe('SUSPENDED');
    expect(
      code(
        await school('PATCH', '/api/v1/admin/settings', GAMMA, cookies['owner@gamma.test'], {
          courseReviewRequired: true,
          reason: 'Try',
        }),
      ),
    ).toBe('SCHOOL_READ_ONLY');
    expect(
      (await school('GET', '/api/v1/admin/settings', GAMMA, cookies['owner@gamma.test'])).statusCode,
    ).toBe(200);
    const [mail] = await emails(tenants.gamma!, 'school-status', 'owner@gamma.test');
    expect(mail!.vars).toMatchObject({ reason: 'Unpaid invoice' });
    const platformLog = await platformSql(
      `SELECT action FROM platform_audit_log WHERE tenant_ref = $1 ORDER BY id`,
      [tenants.gamma],
    );
    expect(platformLog.rows.map((r: Json) => r.action)).toEqual(
      expect.arrayContaining(['tenant.created', 'tenant.feature_override', 'tenant.suspend']),
    );
    await ok(
      await consoleCall('POST', `/console/tenants/${tenants.gamma}/unsuspend`, 'PLATFORM_OPERATOR', {
        reason: 'Paid',
      }),
    );
    expect((await ok(await school('GET', '/api/v1/tenant', GAMMA))).status).toBe('ACTIVE');
  });

  // -------------------------------------------------------------------------------------------------
  // AC 2: the console exposes no personal data without a grant
  // -------------------------------------------------------------------------------------------------

  it('AC 2 (F43): console responses carry metadata and aggregates, never school members’ data', async () => {
    const people = [
      'owner@acme.test',
      'admin@acme.test',
      'l1@example.com',
      'Olu Owner',
      'Learner 1',
      'Tiko Phiri',
      'owner@beta.test',
      'Beth Owner',
    ];
    const responses = [
      await consoleCall('GET', '/console/overview', 'PLATFORM_OWNER'),
      await consoleCall('GET', '/console/metrics', 'PLATFORM_OWNER'),
      await consoleCall('GET', '/console/tenants', 'PLATFORM_OWNER'),
      await consoleCall('GET', `/console/tenants/${tenants.acme}`, 'PLATFORM_OWNER'),
      await consoleCall('GET', `/console/tenants/${tenants.beta}`, 'PLATFORM_OWNER'),
      await consoleCall('GET', '/console/plans', 'PLATFORM_OWNER'),
      await consoleCall('GET', '/console/audit-log', 'PLATFORM_OWNER'),
      await consoleCall('GET', '/console/statements', 'PLATFORM_OWNER'),
      await consoleCall('GET', '/console/domain-change-requests', 'PLATFORM_OWNER'),
      await consoleCall('GET', '/console/support-access', 'PLATFORM_OWNER'),
    ];
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
      for (const person of people) expect(response.body, response.raw.req.url).not.toContain(person);
    }
    // Roles: support staff read schools, but don't manage plans or see the platform audit log.
    expect((await consoleCall('GET', '/console/tenants', 'PLATFORM_SUPPORT')).statusCode).toBe(200);
    expect((await consoleCall('GET', '/console/plans', 'PLATFORM_SUPPORT')).statusCode).toBe(403);
    expect((await consoleCall('GET', '/console/audit-log', 'PLATFORM_OPERATOR')).statusCode).toBe(403);
    // A school session can't reach the console, and the console API doesn't exist on school hosts.
    expect(
      (await h.call('GET', '/console/tenants', { host: ACME, cookie: cookies['owner@acme.test'] }))
        .statusCode,
    ).toBe(404);
  });

  // -------------------------------------------------------------------------------------------------
  // AC 3: support-session exclusions and expiry
  // -------------------------------------------------------------------------------------------------

  it('AC 3 (F44, BR-47): approval, hand-off, read-only scope, exclusions, dual audit, revoke and expiry', async () => {
    const admin = cookies['admin@acme.test']!;
    const reason = 'Investigating a payment question raised by the school';
    const request = async (scope: string) =>
      ok(
        await consoleCall('POST', '/console/support-access', 'PLATFORM_SUPPORT', {
          tenantId: tenants.acme,
          reason,
          scope,
          durationMinutes: 60,
        }),
        201,
      );
    expect(
      code(
        await consoleCall('POST', '/console/support-access', 'PLATFORM_SUPPORT', {
          tenantId: tenants.acme,
          reason: 'short',
          scope: 'READ_ONLY',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const readOnly = await request('READ_ONLY');
    expect(readOnly.status).toBe('REQUESTED');
    expect((await emails(tenants.acme!, 'support-request')).map((e) => e.to)).toEqual(
      expect.arrayContaining(['owner@acme.test', 'admin@acme.test']),
    );
    expect(
      code(await consoleCall('POST', `/console/support-access/${readOnly.id}/open`, 'PLATFORM_SUPPORT')),
    ).toBe('INVALID_STATE');
    // Another school never sees the request.
    expect(
      JSON.stringify(
        await ok(await school('GET', '/api/v1/admin/support-access', BETA, cookies['owner@beta.test'])),
      ),
    ).not.toContain(readOnly.id);

    const approved = await ok(
      await school('POST', `/api/v1/admin/support-access/${readOnly.id}/decision`, ACME, admin, {
        decision: 'APPROVE',
      }),
    );
    expect(approved).toMatchObject({ status: 'APPROVED', staffName: 'Staff platform_support' });
    // Only the requesting staff member can open it.
    expect(
      (await consoleCall('POST', `/console/support-access/${readOnly.id}/open`, 'PLATFORM_OPERATOR'))
        .statusCode,
    ).toBe(404);

    async function openSession(grantId: string): Promise<string> {
      const { url } = await ok(
        await consoleCall('POST', `/console/support-access/${grantId}/open`, 'PLATFORM_SUPPORT'),
      );
      expect(url).toMatch(/^http:\/\/acme\.localhost:3000\/support\/open#token=/);
      const token = tokenFrom(url);
      const exchanged = await school('POST', '/api/v1/support/handoff', ACME, undefined, { token });
      expect(exchanged.statusCode, exchanged.body).toBe(200);
      expect(code(await school('POST', '/api/v1/support/handoff', ACME, undefined, { token }))).toBe(
        'TOKEN_INVALID',
      );
      // The token is bound to its school.
      return cookieFrom(exchanged.headers['set-cookie'], SUPPORT_COOKIE)!;
    }
    const ro = await openSession(readOnly.id);
    expect((await ok(await school('GET', '/api/v1/me', ACME, ro))).support).toMatchObject({
      scope: 'READ_ONLY',
      staffName: 'Staff platform_support',
    });
    expect((await ok(await school('GET', '/api/v1/admin/users', ACME, ro))).total).toBeGreaterThan(3);
    expect(
      code(
        await school('PATCH', '/api/v1/admin/settings', ACME, ro, {
          courseReviewRequired: true,
          reason: 'Try',
        }),
      ),
    ).toBe('SUPPORT_READ_ONLY');
    // The support cookie means nothing on another school's host.
    expect((await school('GET', '/api/v1/admin/users', BETA, ro)).statusCode).toBe(401);
    // Every request is in both logs (F44, F49).
    const schoolEntries = (
      await sql(tenants.acme!, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'support.request'`)
    ).rows[0].n;
    const platformEntries = (
      await platformSql(
        `SELECT count(*)::int AS n FROM platform_audit_log WHERE action = 'support.request' AND tenant_ref = $1`,
        [tenants.acme],
      )
    ).rows[0].n;
    expect(schoolEntries).toBeGreaterThanOrEqual(3);
    expect(platformEntries).toBe(schoolEntries);
    const viewer = await ok(
      await school('GET', '/api/v1/admin/audit-log?action=support.request', ACME, cookies['owner@acme.test']),
    );
    expect(viewer.entries[0]).toMatchObject({
      actorKind: 'STAFF',
      actorName: 'Staff platform_support (platform support)',
    });

    // READ_WRITE: admin writes work, BR-47 exclusions don't.
    const readWrite = await request('READ_WRITE');
    await ok(
      await school('POST', `/api/v1/admin/support-access/${readWrite.id}/decision`, ACME, admin, {
        decision: 'APPROVE',
      }),
    );
    const rw = await openSession(readWrite.id);
    await ok(
      await school('PATCH', '/api/v1/admin/settings', ACME, rw, {
        orderExpiryMinutes: 50,
        reason: 'Support fix',
      }),
    );
    for (const [method, url, body] of [
      ['POST', '/api/v1/admin/payment-accounts', { provider: 'fake', label: 'X', credentials: {} }],
      ['POST', `/api/v1/admin/payment-accounts/${acmeAccount}/activate`, undefined],
      ['POST', '/api/v1/admin/domains/change-requests', { requestedSlug: 'acme-new', reason: 'Support' }],
      [
        'PUT',
        `/api/v1/admin/members/${await membershipOf(tenants.acme!, 'admin@acme.test')}/roles`,
        { roles: ['LEARNER', 'TENANT_OWNER'] },
      ],
      [
        'POST',
        '/api/v1/admin/owners/transfer',
        { membershipId: await membershipOf(tenants.acme!, 'admin@acme.test') },
      ],
      ['POST', '/api/v1/admin/offboarding', { confirmName: 'Acme Academy' }],
      ['POST', `/api/v1/admin/support-access/${readWrite.id}/revoke`, undefined],
    ] as const) {
      expect(code(await school(method, url, ACME, rw, body)), url).toBe('SUPPORT_ACTION_EXCLUDED');
    }

    // The school revokes the READ_WRITE grant: it stops on the next request (F44 AC 2).
    await ok(await school('POST', `/api/v1/admin/support-access/${readWrite.id}/revoke`, ACME, admin));
    expect((await school('GET', '/api/v1/admin/users', ACME, rw)).statusCode).toBe(401);
    // The READ_ONLY grant expires: it stops on the next request too (F44 AC 1).
    await sql(
      tenants.acme!,
      `UPDATE support_access_grant SET expires_at = now() - interval '1 second', starts_at = now() - interval '1 hour' WHERE id = $1`,
      [readOnly.id],
    );
    expect((await school('GET', '/api/v1/admin/users', ACME, ro)).statusCode).toBe(401);
    const grants = await ok(await school('GET', '/api/v1/admin/support-access', ACME, admin));
    expect(grants.grants.find((g: Json) => g.id === readOnly.id).status).toBe('EXPIRED');
    expect(grants.grants.find((g: Json) => g.id === readWrite.id).status).toBe('REVOKED');

    // Emergency access: platform owner only, after re-authentication; owners are told at once.
    expect(
      (
        await consoleCall('POST', '/console/support-access/emergency', 'PLATFORM_SUPPORT', {
          tenantId: tenants.acme,
          reason,
          scope: 'READ_ONLY',
          durationMinutes: 30,
        })
      ).statusCode,
    ).toBe(403);
    await platformSql(`UPDATE platform_session SET reauth_at = now() - interval '1 hour'`);
    expect(
      code(
        await consoleCall('POST', '/console/support-access/emergency', 'PLATFORM_OWNER', {
          tenantId: tenants.acme,
          reason,
          scope: 'READ_ONLY',
          durationMinutes: 30,
        }),
      ),
    ).toBe('REAUTH_REQUIRED');
    await freshReauth();
    const emergency = await ok(
      await consoleCall('POST', '/console/support-access/emergency', 'PLATFORM_OWNER', {
        tenantId: tenants.acme,
        reason,
        scope: 'READ_ONLY',
        durationMinutes: 30,
      }),
      201,
    );
    expect(emergency.status).toBe('APPROVED');
    const alerts = (await emails(tenants.acme!, 'support-request')).filter(
      (e) => e.vars.status === 'EMERGENCY',
    );
    expect(alerts.map((e) => e.to)).toEqual(['owner@acme.test']);
    expect(
      code(
        await consoleCall('POST', '/console/support-access', 'PLATFORM_SUPPORT', {
          tenantId: tenants.acme,
          reason,
          durationMinutes: 2000,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  // -------------------------------------------------------------------------------------------------
  // AC 7: the settlement report flags injected mismatches (W7)
  // -------------------------------------------------------------------------------------------------

  it('AC 7 (W7): CSV and provider-list reconciliation flag every mismatch; items are resolved one by one', async () => {
    const admin = cookies['admin@acme.test']!;
    const [r1, r2, r3, r4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await acmeSale(10_000, { reference: r1 });
    await acmeSale(20_000, { reference: r2 });
    const p3 = await acmeSale(30_000, { reference: r3 });
    const csv = [
      'reference,amount_minor,currency,status,date',
      `${r1},10000,ZMW,SUCCEEDED,${today}`,
      `${r2},25000,ZMW,SUCCEEDED,${today}`,
      `${r4},5000,ZMW,SUCCEEDED,${today}`,
      `${randomUUID()},7000,ZMW,FAILED,${today}`,
    ].join('\n');
    const created = await ok(
      await school('POST', '/api/v1/admin/reconciliation/settlements', ACME, admin, {
        source: 'CSV',
        from: today,
        to: today,
        csv,
      }),
      201,
    );
    const detail = await ok(
      await school('GET', `/api/v1/admin/reconciliation/settlements/${created.id}`, ACME, admin),
    );
    expect(detail.report).toMatchObject({
      source: 'CSV',
      providerCount: 3,
      matchedCount: 1,
      unresolvedCount: detail.items.length,
    });
    const byRef = new Map(detail.items.map((item: Json) => [item.reference, item]));
    expect(byRef.get(r2)).toMatchObject({
      kind: 'AMOUNT_MISMATCH',
      localAmountMinor: 20_000,
      providerAmountMinor: 25_000,
    });
    expect(byRef.get(r4)).toMatchObject({
      kind: 'MISSING_LOCAL',
      paymentId: null,
      providerAmountMinor: 5000,
    });
    expect(byRef.get(r3)).toMatchObject({
      kind: 'MISSING_PROVIDER',
      paymentId: p3,
      localAmountMinor: 30_000,
    });
    expect(
      code(
        await school('POST', '/api/v1/admin/reconciliation/settlements', ACME, admin, {
          source: 'CSV',
          from: today,
          to: today,
          csv: 'ref\nx',
        }),
      ),
    ).toBe('VALIDATION_FAILED');

    // Resolution: a note needs text; a re-check needs a payment; each is audited.
    const missingLocal = byRef.get(r4) as Json;
    const resolve = (itemId: string, body: Json) =>
      school(
        'POST',
        `/api/v1/admin/reconciliation/settlements/${created.id}/items/${itemId}/resolve`,
        ACME,
        admin,
        body,
      );
    expect(code(await resolve(missingLocal.id, { action: 'NOTE' }))).toBe('VALIDATION_FAILED');
    expect(code(await resolve(missingLocal.id, { action: 'RECHECK' }))).toBe('INVALID_STATE');
    await ok(
      await resolve(missingLocal.id, {
        action: 'NOTE',
        note: 'Paid at the counter; raising with the provider',
      }),
      204,
    );
    await ok(
      await resolve((byRef.get(r2) as Json).id, { action: 'ACCEPT', note: 'Provider fee shown gross' }),
      204,
    );
    const after = await ok(
      await school('GET', `/api/v1/admin/reconciliation/settlements/${created.id}`, ACME, admin),
    );
    expect(after.report.unresolvedCount).toBe(detail.items.length - 2);
    const queue = (await ok(await school('GET', '/api/v1/admin/queues/summary', ACME, admin))).queues.find(
      (q: Json) => q.key === 'settlement',
    );
    expect(queue.count).toBe(after.report.unresolvedCount);

    // The provider list API (FULL profile): only what the provider settled is listed.
    await h.migrator.query(
      `INSERT INTO fake_provider.transaction (id, merchant_id, reference, method, amount_minor, currency, status, updated_at)
       VALUES ($1, 'acme-m-0001', $2, 'MOBILE_MONEY', 10000, 'ZMW', 'SUCCEEDED', now())`,
      [`fake_tx_${randomUUID()}`, r1],
    );
    const listed = await ok(
      await school('POST', '/api/v1/admin/reconciliation/settlements', ACME, admin, {
        source: 'API',
        from: today,
        to: today,
      }),
      201,
    );
    const apiReport = await ok(
      await school('GET', `/api/v1/admin/reconciliation/settlements/${listed.id}`, ACME, admin),
    );
    expect(apiReport.report).toMatchObject({ source: 'API', providerCount: 1, matchedCount: 1 });
    expect(apiReport.items.every((item: Json) => item.kind === 'MISSING_PROVIDER')).toBe(true);
    // Another school can't open the report.
    expect(
      (
        await school(
          'GET',
          `/api/v1/admin/reconciliation/settlements/${created.id}`,
          BETA,
          cookies['owner@beta.test'],
        )
      ).statusCode,
    ).toBe(404);
  });

  // -------------------------------------------------------------------------------------------------
  // F32 and AC 4: reports, exports and the full school export
  // -------------------------------------------------------------------------------------------------

  it('F32 AC: dashboard totals equal export totals; AC 4: the full export holds only the school’s own rows', async () => {
    const admin = cookies['admin@acme.test']!;
    const owner = cookies['owner@acme.test']!;
    await acmeSale(12_500, { refund: true });
    const learner = await membershipOf(tenants.acme!, 'l2@example.com');
    await sql(
      tenants.acme!,
      `INSERT INTO enrollment (tenant_id, membership_id, course_id, source) VALUES ($1, $2, $3, 'FREE')`,
      [tenants.acme, learner, acmeCourse],
    );

    const overview = await ok(
      await school('GET', `/api/v1/admin/reports/overview?from=${today}&to=${today}`, ACME, admin),
    );
    expect(overview.revenue).toEqual({
      gross: acmeMoney.sales,
      refunds: acmeMoney.refunds,
      net: acmeMoney.sales - acmeMoney.refunds,
      orders: overview.revenue.orders,
    });
    expect(overview.series).toHaveLength(1);
    expect(overview.series[0].gross).toBe(acmeMoney.sales);

    const payments = await ok(
      await school('POST', '/api/v1/admin/exports', ACME, admin, {
        type: 'PAYMENTS',
        from: today,
        to: today,
      }),
      201,
    );
    const enrolments = await ok(
      await school('POST', '/api/v1/admin/exports', ACME, admin, {
        type: 'ENROLMENTS',
        from: today,
        to: today,
      }),
      201,
    );
    expect(code(await school('POST', '/api/v1/admin/exports/tenant', ACME, admin))).toBe('FORBIDDEN');
    const full = await ok(await school('POST', '/api/v1/admin/exports/tenant', ACME, owner), 201);
    const handler = createExportHandler({
      prisma,
      locations: h.app.get<StorageLocations>(STORAGE_LOCATIONS),
      box,
      schoolUrlTemplate: 'http://{host}:3000',
    });
    expect(await runJobs(tenants.acme!, EXPORT_JOB, handler as never)).toBe(3);

    const paymentsView = await ok(await school('GET', `/api/v1/admin/exports/${payments.id}`, ACME, admin));
    expect(paymentsView).toMatchObject({ status: 'READY', type: 'PAYMENTS' });
    expect(paymentsView.downloadUrl).toMatch(/^http/);
    const key = (id: string) =>
      sql(tenants.acme!, `SELECT storage_key FROM data_export WHERE id = $1`, [id]).then(
        (r) => r.rows[0].storage_key as string,
      );
    const rows = (await readObject(await key(payments.id)))
      .toString()
      .trim()
      .split('\r\n')
      .slice(1)
      .map((line) => line.split(','));
    const exportedGross = rows
      .filter((row) => row[4] === 'SUCCEEDED' || row[4] === 'REFUNDED')
      .reduce((total, row) => total + Number(row[7]), 0);
    expect(exportedGross).toBe(overview.revenue.gross);
    const enrolmentRows =
      (await readObject(await key(enrolments.id))).toString().trim().split('\r\n').length - 1;
    expect(enrolmentRows).toBe(overview.enrolments);
    expect((await emails(tenants.acme!, 'export-ready', 'admin@acme.test')).length).toBe(2);

    // The full export: owners only; every school table, each row this school's own (F46 AC 1).
    expect((await school('GET', `/api/v1/admin/exports/${full.id}`, ACME, admin)).statusCode).toBe(403);
    expect((await ok(await school('GET', `/api/v1/admin/exports/${full.id}`, ACME, owner))).status).toBe(
      'READY',
    );
    const zip = readZip(await readObject(await key(full.id)));
    const skipped = new Set(['tenant_archive', 'idempotency_key', 'outbox', 'support_session', 'session']);
    for (const table of await tenantOwnedTables(h.migrator)) {
      if (skipped.has(table)) continue;
      const file = zip.get(`data/${table}.json`);
      expect(file, table).toBeDefined();
      for (const row of JSON.parse(file!.toString()) as Json[])
        expect(row.tenant_id, table).toBe(tenants.acme);
    }
    const everything = [...zip.values()].map((b) => b.toString('latin1')).join('\n');
    for (const marker of [tenants.beta!, tenants.gamma!, 'owner@beta.test', 'Beth Owner', 'b1@example.com']) {
      expect(everything).not.toContain(marker);
    }
    expect(everything).toContain('owner@acme.test');
    expect(everything).not.toContain('fixture-acme-api-key-1234'); // credentials are ciphertext and left out
    expect(zip.get('summaries/members.csv')!.toString()).toContain('Learner 2');
    // Beta can't fetch Acme's export.
    expect(
      (await school('GET', `/api/v1/admin/exports/${full.id}`, BETA, cookies['owner@beta.test'])).statusCode,
    ).toBe(404);
  });

  // -------------------------------------------------------------------------------------------------
  // AC 6: statement arithmetic matches recorded sales minus refunds (W8)
  // -------------------------------------------------------------------------------------------------

  it('the export worker refuses a full export queued before its school lost dataExport', async () => {
    const owner = cookies['owner@acme.test']!;
    const full = await ok(await school('POST', '/api/v1/admin/exports/tenant', ACME, owner), 201);
    await ok(await school('PUT', '/api/v1/admin/features/dataExport', ACME, owner, { enabled: false }), 204);
    try {
      const handler = createExportHandler({
        prisma,
        locations: h.app.get<StorageLocations>(STORAGE_LOCATIONS),
        box,
        schoolUrlTemplate: 'http://{host}:3000',
      });
      expect(await runJobs(tenants.acme!, EXPORT_JOB, handler as never)).toBe(1);
      const result = await sql(
        tenants.acme!,
        'SELECT status, error, storage_key FROM data_export WHERE id = $1',
        [full.id],
      );
      expect(result.rows[0]).toMatchObject({
        status: 'FAILED',
        error: 'FEATURE_NOT_ENABLED',
        storage_key: null,
      });
      expect(await storage.head(`t/${tenants.acme}/exports/${full.id}.zip`)).toBeNull();
      expect((await ok(await school('GET', '/api/v1/tenant', BETA))).features.dataExport).toBe(true);
    } finally {
      await ok(await school('PUT', '/api/v1/admin/features/dataExport', ACME, owner, { enabled: true }), 204);
    }
  });

  it('AC 6 (W8, BR-63): monthly statements from recorded sales; drafts hidden; issued amounts frozen', async () => {
    const generated = await ok(
      await consoleCall('POST', '/console/statements/generate', 'PLATFORM_OPERATOR', { period }),
    );
    expect(generated.created).toBeGreaterThanOrEqual(3);
    expect(
      await ok(await consoleCall('POST', '/console/statements/generate', 'PLATFORM_OPERATOR', { period })),
    ).toEqual({ created: 0, skipped: generated.created });
    const list = await ok(
      await consoleCall('GET', `/console/statements?period=${period}`, 'PLATFORM_OPERATOR'),
    );
    const acme = list.statements.find((s: Json) => s.tenantId === tenants.acme);
    const base = acmeMoney.sales - acmeMoney.refunds;
    expect(acme).toMatchObject({
      status: 'DRAFT',
      planCode: 'school-standard',
      subscriptionFeeMinor: 50_000,
      salesGrossMinor: acmeMoney.sales,
      refundsMinor: acmeMoney.refunds,
      platformCommissionBps: 500,
      platformCommissionMinor: Math.floor((base * 500 + 5000) / 10_000),
      totalDueMinor: 50_000 + Math.floor((base * 500 + 5000) / 10_000),
    });
    const gamma = list.statements.find((s: Json) => s.tenantId === tenants.gamma);
    expect(gamma).toMatchObject({
      planCode: 'starter',
      subscriptionFeeMinor: 20_000,
      platformCommissionMinor: 0,
      totalDueMinor: 20_000,
    });

    const owner = cookies['owner@acme.test']!;
    expect(
      (await ok(await school('GET', '/api/v1/admin/billing/statements', ACME, owner))).statements,
    ).toEqual([]);
    await ok(await consoleCall('POST', `/console/statements/${acme.id}/issue`, 'PLATFORM_OPERATOR'), 204);
    const billing = await ok(await school('GET', '/api/v1/admin/billing/statements', ACME, owner));
    expect(billing.statements).toHaveLength(1);
    expect(billing.statements[0]).toMatchObject({
      id: acme.id,
      status: 'ISSUED',
      totalDueMinor: acme.totalDueMinor,
    });
    expect(
      (await school('GET', '/api/v1/admin/billing/statements', ACME, cookies['admin@acme.test'])).statusCode,
    ).toBe(403);
    expect(
      (await school('GET', `/api/v1/admin/billing/statements/${acme.id}`, BETA, cookies['owner@beta.test']))
        .statusCode,
    ).toBe(404);
    expect((await emails(tenants.acme!, 'statement-issued', 'owner@acme.test')).length).toBe(1);

    // Issued amounts can't change, even in the console realm; corrections are VOID + a new statement.
    await expect(
      platformSql(
        `UPDATE platform_statement SET total_due_minor = total_due_minor + 1, subscription_fee_minor = subscription_fee_minor + 1 WHERE id = $1`,
        [acme.id],
      ),
    ).rejects.toThrow(/can't be changed/);
    await ok(
      await consoleCall('POST', `/console/statements/${acme.id}/mark-paid`, 'PLATFORM_OPERATOR', {
        externalReference: 'BANK-123',
      }),
      204,
    );
    expect(
      code(
        await consoleCall('POST', `/console/statements/${acme.id}/void`, 'PLATFORM_OPERATOR', {
          reason: 'Mistake',
        }),
      ),
    ).toBe('INVALID_STATE');
  });

  // -------------------------------------------------------------------------------------------------
  // F30, F31, F33, F49
  // -------------------------------------------------------------------------------------------------

  it('F30: search, detail, suspend (never yourself), sessions; F31 overdue queues; F33 notifications', async () => {
    const admin = cookies['admin@acme.test']!;
    const owner = cookies['owner@acme.test']!;
    const users = await ok(await school('GET', '/api/v1/admin/users?q=learner', ACME, admin));
    expect(users.users.map((u: Json) => u.email).sort()).toEqual(['l1@example.com', 'l2@example.com']);
    const learnerId = await membershipOf(tenants.acme!, 'l1@example.com');
    const detail = await ok(await school('GET', `/api/v1/admin/users/${learnerId}`, ACME, admin));
    expect(detail.user).toMatchObject({ email: 'l1@example.com', isSelf: false });
    expect(detail.orders.length).toBeGreaterThan(0);
    expect(detail.sessions.length).toBeGreaterThan(0);
    // Another school's member is simply not found.
    expect(
      (
        await school(
          'GET',
          `/api/v1/admin/users/${await membershipOf(tenants.beta!, 'b1@example.com')}`,
          ACME,
          admin,
        )
      ).statusCode,
    ).toBe(404);

    const self = await membershipOf(tenants.acme!, 'admin@acme.test');
    expect(
      (await school('POST', `/api/v1/admin/users/${self}/suspend`, ACME, admin, { reason: 'Test' }))
        .statusCode,
    ).toBe(403);
    const ownerId = await membershipOf(tenants.acme!, 'owner@acme.test');
    expect(
      (await school('POST', `/api/v1/admin/users/${ownerId}/suspend`, ACME, admin, { reason: 'Coup' }))
        .statusCode,
    ).toBe(403);
    await ok(
      await school('POST', `/api/v1/admin/users/${learnerId}/suspend`, ACME, admin, {
        reason: 'Abuse report',
      }),
      204,
    );
    expect((await school('GET', '/api/v1/me', ACME, cookies['l1@example.com'])).statusCode).toBe(401);
    await ok(
      await school('POST', `/api/v1/admin/users/${learnerId}/unsuspend`, ACME, admin, { reason: 'Resolved' }),
      204,
    );
    cookies['l1@example.com'] = await h.signIn(ACME, 'l1@example.com');

    // F31: an application older than 72 hours is overdue.
    const applicant = await membershipOf(tenants.acme!, 'l2@example.com');
    await sql(
      tenants.acme!,
      `INSERT INTO instructor_profile (membership_id, tenant_id, slug, display_name, status, submitted_at) VALUES ($1, $2, 'l2', 'Learner 2', 'SUBMITTED', now() - interval '4 days')`,
      [applicant, tenants.acme],
    );
    const queues = await ok(await school('GET', '/api/v1/admin/queues/summary', ACME, admin));
    expect(queues.queues.find((q: Json) => q.key === 'applications')).toMatchObject({
      count: 1,
      overdue: true,
    });
    expect(
      (await school('GET', '/api/v1/admin/queues/summary', ACME, cookies['l1@example.com'])).statusCode,
    ).toBe(403);

    // F33: owners got in-app notifications for the emails above; preferences round-trip.
    const inbox = await ok(await school('GET', '/api/v1/me/notifications', ACME, owner));
    expect(inbox.unread).toBeGreaterThan(0);
    expect(inbox.items.map((n: Json) => n.kind)).toEqual(
      expect.arrayContaining(['support-request', 'statement-issued']),
    );
    await ok(await school('POST', '/api/v1/me/notifications/read', ACME, owner, { all: true }), 204);
    expect((await ok(await school('GET', '/api/v1/me/notifications', ACME, owner))).unread).toBe(0);
    expect(
      await ok(
        await school('PUT', '/api/v1/me/notification-preferences', ACME, owner, {
          learning: true,
          earnings: false,
        }),
      ),
    ).toEqual({ learning: true, earnings: false });
    expect(await ok(await school('GET', '/api/v1/me/notification-preferences', ACME, owner))).toEqual({
      learning: true,
      earnings: false,
    });
  });

  it('F49 AC: each school admin mutation writes exactly one school entry; each console mutation one platform entry', async () => {
    const owner = cookies['owner@acme.test']!;
    const schoolCount = async () =>
      (await sql(tenants.acme!, `SELECT count(*)::int AS n FROM audit_log`)).rows[0].n as number;
    const platformCount = async () =>
      (await platformSql(`SELECT count(*)::int AS n FROM platform_audit_log`)).rows[0].n as number;
    const editor = await ok(await school('GET', '/api/v1/admin/branding', ACME, owner));
    const mutations: [string, string, unknown][] = [
      ['PATCH', '/api/v1/admin/settings', { downloadsAllowedDefault: true, reason: 'Allow downloads' }],
      ['PUT', '/api/v1/admin/features/quizAnalytics', { enabled: false }],
      ['PUT', '/api/v1/admin/branding/draft', { ...editor.draft, accentHex: '#1d5da6' }],
      ['POST', '/api/v1/admin/branding/publish', undefined],
      [
        'PUT',
        '/api/v1/admin/locales',
        { defaultLocale: 'en', enabledLocales: ['en'], timeZone: 'Africa/Lusaka', reason: 'Back home' },
      ],
      ['POST', '/api/v1/admin/exports', { type: 'ORDERS', from: today, to: today }],
    ];
    for (const [method, url, body] of mutations) {
      const before = await schoolCount();
      const response = await school(method as never, url, ACME, owner, body);
      expect(response.statusCode, `${url}: ${response.body}`).toBeLessThan(300);
      expect(await schoolCount(), url).toBe(before + 1);
    }
    await freshReauth();
    const plans = await ok(await consoleCall('GET', '/console/plans', 'PLATFORM_OWNER'));
    const before = await platformCount();
    await ok(
      await consoleCall('PATCH', `/console/plans/${plans.plans[0].id}`, 'PLATFORM_OWNER', {
        isPublic: false,
        reason: 'Hide',
      }),
    );
    expect(await platformCount()).toBe(before + 1);
    const settings = await ok(
      await consoleCall('PUT', '/console/settings', 'PLATFORM_OWNER', {
        maintenanceBanner: 'Maintenance tonight at 22:00',
        reason: 'Upgrade',
      }),
    );
    expect(settings.maintenanceBanner).toBe('Maintenance tonight at 22:00');
    expect(await platformCount()).toBe(before + 2);
    // The banner shows on every school (S-C08).
    expect((await ok(await school('GET', '/api/v1/tenant', BETA))).notice).toBe(
      'Maintenance tonight at 22:00',
    );
    await ok(
      await consoleCall('PUT', '/console/settings', 'PLATFORM_OWNER', {
        maintenanceBanner: null,
        reason: 'Done',
      }),
    );
  });

  // -------------------------------------------------------------------------------------------------
  // AC 5: offboarding purge
  // -------------------------------------------------------------------------------------------------

  it('AC 5 (F46, BR-53): offboarding → 30-day read-only grace → purge archives money and deletes the rest', async () => {
    const created = await ok(
      await consoleCall('POST', '/console/tenants', 'PLATFORM_OPERATOR', {
        name: 'Delta School',
        kind: 'SCHOOL',
        slug: 'delta',
        planCode: 'school-standard',
        ownerEmail: 'owner@delta.test',
      }),
      201,
    );
    const delta = created.id as string;
    const DELTA = 'delta.localhost';
    const [invitation] = await emails(delta, 'invitation', 'owner@delta.test');
    const accepted = await school('POST', '/api/v1/invitations/accept', DELTA, undefined, {
      token: tokenFrom(invitation!.vars.link),
      password: PASSWORD,
      displayName: 'Dee Owner',
    });
    const owner = cookieFrom(accepted.headers['set-cookie'])!;
    await freshReauth();
    await ok(
      await consoleCall('POST', `/console/tenants/${delta}/activate`, 'PLATFORM_OPERATOR', {
        reason: 'Ready',
      }),
    );
    const ownerId = await membershipOf(delta, 'owner@delta.test');
    await sql(
      delta,
      `INSERT INTO course (tenant_id, owner_membership_id, slug, title) VALUES ($1, $2, 'c1', 'Course one')`,
      [delta, ownerId],
    );
    const order = (
      await sql(
        delta,
        `INSERT INTO "order" (tenant_id, membership_id, status, currency, total_minor, expires_at) VALUES ($1, $2, 'PENDING', 'ZMW', 100, now()) RETURNING id`,
        [delta, ownerId],
      )
    ).rows[0].id;
    await storage.put(`t/${delta}/exports/fixture.txt`, Buffer.from('delta file'), 'text/plain');

    expect(
      code(await school('POST', '/api/v1/admin/offboarding', DELTA, owner, { confirmName: 'Delta' })),
    ).toBe('CONFIRMATION_MISMATCH');
    const view = await ok(
      await school('POST', '/api/v1/admin/offboarding', DELTA, owner, { confirmName: 'Delta School' }),
    );
    expect(view.status).toBe('OFFBOARDING');
    expect(Date.parse(view.deleteAfter) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    // Read-only during the grace period, but export and cancel still work (BR-53).
    expect(
      code(
        await school('PATCH', '/api/v1/admin/settings', DELTA, owner, {
          courseReviewRequired: true,
          reason: 'Try',
        }),
      ),
    ).toBe('SCHOOL_READ_ONLY');
    expect((await school('GET', '/api/v1/admin/offboarding', DELTA, owner)).statusCode).toBe(200);
    await ok(await school('DELETE', '/api/v1/admin/offboarding', DELTA, owner));
    await ok(
      await school('POST', '/api/v1/admin/offboarding', DELTA, owner, { confirmName: 'Delta School' }),
    );

    const purge = createPurgeHandler({ prisma, locations: h.app.get<StorageLocations>(STORAGE_LOCATIONS) });
    const run = () =>
      runWithContext({ requestId: 'purge', tenantId: delta }, () =>
        purge({ type: 'admin.tenant-purge', tenantId: delta, payload: {}, requestId: 'purge' }, silent),
      );
    // Not before the grace period ends; never for a live school.
    expect(await run()).toEqual({ deleted: 0 });
    expect(
      await runWithContext({ requestId: 'purge', tenantId: tenants.acme! }, () =>
        purge(
          { type: 'admin.tenant-purge', tenantId: tenants.acme!, payload: {}, requestId: 'purge' },
          silent,
        ),
      ),
    ).toEqual({ deleted: 0 });
    await platformSql(`UPDATE tenant SET delete_after = now() - interval '1 minute' WHERE id = $1`, [delta]);
    // A file still being scanned holds the purge; one stuck for a day (and a stuck export) is retired.
    const scanning = (
      await sql(
        delta,
        `INSERT INTO asset (tenant_id, owner_membership_id, kind, purpose, original_name, mime, size_bytes,
           storage_key, storage_location_id, status)
         VALUES ($1, $2, 'DOCUMENT', 'LESSON_FILE', 'scan.pdf', 'application/pdf', 10, $3, $4, 'SCANNING')
         RETURNING id`,
        [delta, ownerId, `t/${delta}/lesson_file/scan.pdf`, BOOTSTRAP_STORAGE_LOCATION_ID],
      )
    ).rows[0].id;
    expect(await run()).toEqual({ deleted: 0 });
    await sql(delta, `UPDATE asset SET updated_at = now() - interval '2 days' WHERE id = $1`, [scanning]);
    await sql(
      delta,
      `INSERT INTO data_export (tenant_id, type, status, requested_by, created_at)
       VALUES ($1, 'TENANT_FULL', 'RUNNING', $2, now() - interval '2 days')`,
      [delta, ownerId],
    );
    // A superseded storage location whose credentials can't be opened doesn't block the purge.
    const revoked = '00000000-0000-4000-8000-0000000000ee';
    await platformSql(
      `INSERT INTO platform_storage_location (id, provider, config, credentials_enc, fingerprint)
       SELECT $1, provider, config, $2, repeat('e', 64) FROM platform_storage_location WHERE id = $3`,
      [revoked, Buffer.alloc(32), BOOTSTRAP_STORAGE_LOCATION_ID],
    );
    // (Locations are immutable and stay registered; this suite's database is disposable.)
    const result = await run();
    expect(result.deleted).toBeGreaterThan(5);

    // F46 AC 2: no school rows remain except the archive; the host no longer resolves; files are gone.
    for (const table of await tenantOwnedTables(h.migrator)) {
      const { rows } = await sql(delta, `SELECT count(*)::int AS n FROM "${table}" WHERE tenant_id = $1`, [
        delta,
      ]);
      if (table === 'tenant_archive') expect(rows[0].n).toBeGreaterThan(0);
      else expect(rows[0].n, table).toBe(0);
    }
    const archived = await sql(
      delta,
      `SELECT source_table, row_data->>'id' AS id FROM tenant_archive WHERE tenant_id = $1`,
      [delta],
    );
    expect(archived.rows).toEqual(expect.arrayContaining([{ source_table: 'order', id: order }]));
    expect(archived.rows.some((r: Json) => r.source_table === 'audit_log')).toBe(true);
    expect((await platformSql(`SELECT status::text FROM tenant WHERE id = $1`, [delta])).rows[0].status).toBe(
      'DELETED',
    );
    const gone = await school('GET', '/api/v1/tenant', DELTA);
    expect(gone.statusCode).toBe(404);
    expect(code(gone)).toBe('TENANT_NOT_FOUND');
    expect(await storage.head(`t/${delta}/exports/fixture.txt`)).toBeNull();
    // Other schools are untouched.
    expect((await ok(await school('GET', '/api/v1/tenant', ACME))).status).toBe('ACTIVE');
  });

  // -------------------------------------------------------------------------------------------------
  // Domains (S-AD19, BR-50): last, because it moves Beta to a new address
  // -------------------------------------------------------------------------------------------------

  it('S-AD19 (BR-50): subdomain change request → console approval → new host; the old one redirects', async () => {
    const owner = cookies['owner@beta.test']!;
    const check = async (slug: string) =>
      ok(await school('GET', `/api/v1/admin/domains/availability?slug=${slug}`, BETA, owner));
    expect(await check('acme')).toMatchObject({ available: false, problem: 'TAKEN' });
    expect(await check('admin')).toMatchObject({ available: false, problem: 'RESERVED' });
    expect(await check('beta-college')).toMatchObject({ available: true, problem: null });
    expect(
      code(
        await school('POST', '/api/v1/admin/domains/change-requests', BETA, owner, {
          requestedSlug: 'gamma',
          reason: 'Mine',
        }),
      ),
    ).toBe('SLUG_TAKEN');
    expect(
      (
        await school('POST', '/api/v1/admin/domains/change-requests', BETA, cookies['b1@example.com'], {
          requestedSlug: 'beta-college',
          reason: 'New name',
        })
      ).statusCode,
    ).toBe(403);
    const request = await ok(
      await school('POST', '/api/v1/admin/domains/change-requests', BETA, owner, {
        requestedSlug: 'beta-college',
        reason: 'We renamed the college',
      }),
      201,
    );
    expect(
      code(
        await school('POST', '/api/v1/admin/domains/change-requests', BETA, owner, {
          requestedSlug: 'beta-college-2',
          reason: 'Another',
        }),
      ),
    ).toBe('INVALID_STATE');
    expect(
      code(await school('POST', '/api/v1/admin/domains', BETA, owner, { hostname: 'learn.beta.ac.zm' })),
    ).toBe('FEATURE_NOT_ENABLED');

    const pending = await ok(
      await consoleCall('GET', '/console/domain-change-requests?status=REQUESTED', 'PLATFORM_OPERATOR'),
    );
    expect(pending.requests.map((r: Json) => r.id)).toContain(request.id);
    await ok(
      await consoleCall(
        'POST',
        `/console/domain-change-requests/${request.id}/decision`,
        'PLATFORM_OPERATOR',
        { decision: 'APPROVE', note: 'Matches the registration' },
      ),
      204,
    );

    const moved = await ok(await school('GET', '/api/v1/tenant', 'beta-college.localhost'));
    expect(moved).toMatchObject({ id: tenants.beta, slug: 'beta-college' });
    const old = await school('GET', '/api/v1/tenant', BETA);
    expect(old.statusCode).toBe(421);
    expect(old.json()).toMatchObject({ code: 'TENANT_MOVED', primaryHost: 'beta-college.localhost' });
    const domains = await ok(
      await school(
        'GET',
        '/api/v1/admin/domains',
        'beta-college.localhost',
        await h.signIn('beta-college.localhost', 'owner@beta.test'),
      ),
    );
    expect(domains.domains).toEqual([
      expect.objectContaining({ hostname: 'beta-college.localhost', isPrimary: true, status: 'ACTIVE' }),
      expect.objectContaining({ hostname: 'beta.localhost', isPrimary: false, status: 'REDIRECT' }),
    ]);
    const [mail] = await emails(tenants.beta!, 'domain-decision', 'owner@beta.test');
    expect(mail!.vars).toMatchObject({ status: 'APPROVED', detail: 'beta-college.localhost' });
  });
});

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
