import { createHash } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  CONSOLE_AUTHZ_MATRIX,
  type ConsoleMatrixActor,
  meResponseSchema,
  mySchoolsResponseSchema,
  teamResponseSchema,
  TENANT_AUTHZ_MATRIX,
  type TenantMatrixActor,
} from '@studyhub/contracts';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/main';
import {
  bootstrapStorageLocations,
  createLogger,
  DEV_IDENTITY_ENCRYPTION_KEY,
  hashPassword,
  loadApiEnv,
  PrismaService,
  SecretBox,
  timeStep,
  totpCode,
} from '../../src/modules/platform';
import { provisionTenant } from '../../src/modules/tenancy';
import { startTestDatabase, type TestDatabase } from '../setup/postgres-container';

const ACME = 'acme.localhost';
const BETA = 'beta.localhost';
const CONSOLE = 'console.localhost';
const PASSWORD = 'a long enough passphrase';
const SESSION = '__Host-sh_session';
const CONSOLE_COOKIE = '__Host-sh_console';
const MISSING = '00000000-0000-4000-8000-000000000000';

interface Call {
  host: string;
  cookie?: string | undefined;
  body?: unknown;
  /** Send a same-origin Origin header (default for unsafe methods). */
  origin?: boolean;
  ip?: string;
}

function cookieFrom(setCookie: string | string[] | undefined, name: string): string | undefined {
  const list = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  for (const entry of list) {
    const [pair] = entry.split(';');
    const [key, value] = (pair ?? '').split('=');
    if (key === name && value !== undefined && value !== '') return `${name}=${value}`;
  }
  return undefined;
}

describe('identity realms (M4)', () => {
  let database: TestDatabase;
  let migrator: Client;
  let app: NestFastifyApplication;
  const box = new SecretBox(DEV_IDENTITY_ENCRYPTION_KEY);
  const tenants = { acme: '', beta: '' };
  let ipCounter = 1;

  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, options: Call) => {
    const unsafe = method !== 'GET';
    return app.inject({
      method,
      url,
      remoteAddress: '127.0.0.1',
      headers: {
        host: options.host,
        // A distinct client address per call keeps the per-IP limits out of functional tests.
        'x-forwarded-for': options.ip ?? `198.51.100.${(ipCounter++ % 250) + 1}`,
        ...(options.cookie !== undefined && { cookie: options.cookie }),
        ...(unsafe && options.origin !== false && { origin: `http://${options.host}` }),
        ...(options.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(options.body !== undefined && { payload: JSON.stringify(options.body) }),
    });
  };

  /** Runs SQL as the migrator inside a tenant context (FORCE RLS applies to the owner too). */
  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    await migrator.query('BEGIN');
    try {
      await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn();
      await migrator.query('COMMIT');
      return result;
    } catch (error) {
      await migrator.query('ROLLBACK');
      throw error;
    }
  }

  /** The newest queued email of a template to a recipient, with its sealed variables opened. */
  async function lastEmail(tenantId: string, to: string, template: string): Promise<{ link?: string }> {
    const { rows } = await asTenant(tenantId, () =>
      migrator.query<{ payload: { to: string; sealed: string; template: string } }>(
        `SELECT payload FROM outbox WHERE topic = 'email.send' AND payload->>'to' = $1 AND payload->>'template' = $2
          ORDER BY id DESC LIMIT 1`,
        [to, template],
      ),
    );
    const payload = rows[0]?.payload;
    if (payload === undefined) throw new Error(`no ${template} email to ${to}`);
    return JSON.parse(box.openText(payload.sealed, `email:${tenantId}:${to}`)) as { link?: string };
  }

  const tokenOf = (link: string | undefined) => /#token=([A-Za-z0-9_-]{43})$/.exec(link ?? '')?.[1] ?? '';

  /** Registers on a school host and verifies the email (which signs the person in there). */
  async function member(
    host: string,
    tenantId: string,
    email: string,
    name = 'Test Person',
  ): Promise<string> {
    const register = await call('POST', '/api/v1/auth/register', {
      host,
      body: { displayName: name, email, password: PASSWORD, acceptTerms: true },
    });
    expect(register.statusCode, register.body).toBe(202);
    const token = tokenOf((await lastEmail(tenantId, email, 'verify-email')).link);
    const verified = await call('POST', '/api/v1/auth/verify-email', { host, body: { token } });
    expect(verified.json()).toEqual({ status: 'VERIFIED', signedIn: true });
    return cookieFrom(verified.headers['set-cookie'], SESSION)!;
  }

  async function signIn(host: string, email: string, password = PASSWORD) {
    return call('POST', '/api/v1/auth/sign-in', { host, body: { email, password } });
  }

  async function grantRole(tenantId: string, email: string, role: string): Promise<void> {
    await asTenant(tenantId, () =>
      migrator.query(
        `INSERT INTO membership_role (tenant_id, membership_id, role)
         SELECT m.tenant_id, m.id, $2::"TenantRole" FROM tenant_membership m JOIN user_account a ON a.id = m.user_id
          WHERE a.email = $1`,
        [email, role],
      ),
    );
  }

  /** Signs in again so the session carries newly granted roles. */
  async function freshSession(host: string, email: string): Promise<string> {
    const response = await signIn(host, email);
    expect(response.json()).toEqual({ status: 'SIGNED_IN' });
    return cookieFrom(response.headers['set-cookie'], SESSION)!;
  }

  beforeAll(async () => {
    database = await startTestDatabase({ migrate: true });
    migrator = await database.connect(database.migratorUrl);
    for (const [key, slug, name, hostname] of [
      ['acme', 'acme', 'Acme Academy', ACME],
      ['beta', 'beta', 'Beta College', BETA],
    ] as const) {
      const result = await provisionTenant(migrator, {
        slug,
        name,
        kind: 'SCHOOL',
        hostname,
        status: 'ACTIVE',
      });
      if (result.outcome !== 'created') throw new Error('provisioning failed');
      tenants[key] = result.tenantId;
    }
    // TEST_LOG_LEVEL=error shows server-side failures while debugging this suite.
    const level = (process.env.TEST_LOG_LEVEL ?? 'silent') as 'silent';
    const env = loadApiEnv({ DATABASE_URL_APP: database.appUrl, LOG_LEVEL: level });
    // Storage fails closed until its origin is captured (as `pnpm storage:bootstrap` does on deploy).
    const bootstrapPrisma = new PrismaService(env, createLogger({ level }));
    try {
      await bootstrapStorageLocations({ prisma: bootstrapPrisma, env });
    } finally {
      await bootstrapPrisma.onModuleDestroy();
    }
    app = await createApp({ env, logger: createLogger({ level }) });
  });

  afterAll(async () => {
    await app?.close();
    await migrator?.end();
    await database?.stop();
  });

  describe('accounts and memberships (D3)', () => {
    it('M4 AC 1: one account joins two schools; each school sees only its own membership', async () => {
      const email = 'chanda@example.com';
      const acmeCookie = await member(ACME, tenants.acme, email, 'Chanda Mulenga');

      // Signing in on Beta with the same account offers "Join Beta College" (BR-66).
      const offer = await signIn(BETA, email);
      expect(offer.json()).toMatchObject({ status: 'JOIN_AVAILABLE', schoolName: 'Beta College' });
      const joined = await call('POST', '/api/v1/me/schools/current/join', {
        host: BETA,
        body: { ticket: offer.json().ticket },
      });
      expect(joined.statusCode).toBe(200);
      const betaCookie = cookieFrom(joined.headers['set-cookie'], SESSION)!;

      // The person sees both schools; each school's API knows only its own membership.
      const schools = mySchoolsResponseSchema.parse(
        (await call('GET', '/api/v1/me/schools', { host: ACME, cookie: acmeCookie })).json(),
      );
      expect(schools.schools.map((s) => s.name).sort()).toEqual(['Acme Academy', 'Beta College']);
      const acmeMe = meResponseSchema.parse(
        (await call('GET', '/api/v1/me', { host: ACME, cookie: acmeCookie })).json(),
      );
      const betaMe = meResponseSchema.parse(
        (await call('GET', '/api/v1/me', { host: BETA, cookie: betaCookie })).json(),
      );
      expect(acmeMe.user.id).toBe(betaMe.user.id);
      expect(acmeMe.membership.id).not.toBe(betaMe.membership.id);

      // In the database: Acme's context sees only Acme's membership of this person.
      const visible = await asTenant(tenants.acme, () =>
        migrator.query<{ tenant_id: string }>(`SELECT tenant_id FROM tenant_membership WHERE user_id = $1`, [
          acmeMe.user.id,
        ]),
      );
      expect(visible.rows).toEqual([{ tenant_id: tenants.acme }]);
    });

    it('M4 AC 1: a school admin cannot list global users or see other memberships', async () => {
      await member(ACME, tenants.acme, 'admin1@acme.test', 'Acme Admin');
      await grantRole(tenants.acme, 'admin1@acme.test', 'TENANT_ADMIN');
      const adminCookie = await freshSession(ACME, 'admin1@acme.test');
      // Someone who exists only at Beta.
      await member(BETA, tenants.beta, 'only-beta@example.com', 'Beta Only');

      const team = teamResponseSchema.parse(
        (await call('GET', '/api/v1/admin/team', { host: ACME, cookie: adminCookie })).json(),
      );
      const emails = team.members.map((m) => m.email);
      expect(emails).toContain('chanda@example.com');
      expect(emails).not.toContain('only-beta@example.com');
      expect(JSON.stringify(team)).not.toContain('Beta College');

      // The runtime role in Acme's context sees members' accounts only, never the global table.
      const appClient = await database.connect(database.appUrl);
      try {
        await appClient.query('BEGIN');
        await appClient.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenants.acme]);
        const accounts = await appClient.query<{ email: string }>(`SELECT email FROM user_account`);
        expect(accounts.rows.map((r) => r.email)).not.toContain('only-beta@example.com');
        const credentials = await appClient.query(`SELECT 1 FROM credential`);
        expect(credentials.rowCount).toBe(0);
        await appClient.query('COMMIT');
      } finally {
        await appClient.end();
      }
    });

    it('BR-65: wrong password, unknown email and non-member on a closed school fail identically', async () => {
      await asTenant(tenants.beta, () =>
        migrator.query(
          `INSERT INTO tenant_setting (tenant_id, key, value) VALUES ($1, 'learnerRegistrationMode', '"INVITE_ONLY"')
           ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [tenants.beta],
        ),
      );
      try {
        const wrongPassword = await signIn(BETA, 'chanda@example.com', 'not the right password');
        const unknownEmail = await signIn(BETA, 'nobody-here@example.com');
        const notMember = await signIn(BETA, 'admin1@acme.test'); // valid Acme account, not a Beta member
        for (const response of [wrongPassword, unknownEmail, notMember]) {
          expect(response.statusCode).toBe(401);
          const { requestId: _, ...body } = response.json() as Record<string, unknown>;
          expect(body).toEqual({
            type: 'urn:studyhub:problem:invalid-credentials',
            title: 'Email or password is incorrect',
            status: 401,
            code: 'INVALID_CREDENTIALS',
          });
        }
      } finally {
        await asTenant(tenants.beta, () =>
          migrator.query(`DELETE FROM tenant_setting WHERE key = 'learnerRegistrationMode'`),
        );
      }
    });

    it('BR-66: registering with an existing email answers exactly like a new registration', async () => {
      const fresh = await call('POST', '/api/v1/auth/register', {
        host: BETA,
        body: { displayName: 'New', email: 'brand-new@example.com', password: PASSWORD, acceptTerms: true },
      });
      const existing = await call('POST', '/api/v1/auth/register', {
        host: BETA,
        body: { displayName: 'Again', email: 'chanda@example.com', password: PASSWORD, acceptTerms: true },
      });
      expect(fresh.statusCode).toBe(202);
      expect(existing.statusCode).toBe(202);
      expect(existing.json()).toEqual(fresh.json());
      // The existing account's owner is told by email instead.
      expect((await lastEmail(tenants.beta, 'chanda@example.com', 'account-exists')).link).toMatch(
        /\/sign-in$/,
      );
    });

    it('rejects common passwords and passwords containing the email', async () => {
      for (const password of ['password123', 'zanele likes maths a lot']) {
        const response = await call('POST', '/api/v1/auth/register', {
          host: ACME,
          body: { displayName: 'Z', email: 'zanele@example.com', password, acceptTerms: true },
        });
        expect(response.statusCode).toBe(422);
        expect(response.json().errors[0].field).toBe('password');
      }
    });

    it('locks sign-in after repeated failures (rate limit per account, also for unknown emails)', async () => {
      const ip = '198.51.100.250';
      let last = 0;
      for (let i = 0; i < 12; i += 1) {
        last = (
          await call('POST', '/api/v1/auth/sign-in', {
            host: ACME,
            ip,
            body: { email: 'nobody-at-all@example.com', password: 'wrong wrong wrong' },
          })
        ).statusCode;
      }
      expect(last).toBe(429);
    });
  });

  describe('sessions (D4, BR-44, BR-69)', () => {
    it('M4 AC 2: a session replayed on another school host is rejected', async () => {
      const acmeCookie = await freshSession(ACME, 'chanda@example.com');
      expect((await call('GET', '/api/v1/me', { host: ACME, cookie: acmeCookie })).statusCode).toBe(200);
      const replayed = await call('GET', '/api/v1/me', { host: BETA, cookie: acmeCookie });
      expect(replayed.statusCode).toBe(401);
      expect(String(replayed.headers['set-cookie'])).toContain(`${SESSION}=;`);
    });

    it('sets a host-only, Secure, HttpOnly, SameSite=Lax session cookie', async () => {
      const response = await signIn(ACME, 'chanda@example.com');
      const header = String(response.headers['set-cookie']);
      expect(header).toMatch(
        /^__Host-sh_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/,
      );
      expect(header).not.toMatch(/Domain=/i);
    });

    it('refuses state-changing requests from another origin (CSRF)', async () => {
      const cookie = await freshSession(ACME, 'chanda@example.com');
      const forged = await app.inject({
        method: 'DELETE',
        url: '/api/v1/me/sessions',
        remoteAddress: '127.0.0.1',
        headers: { host: ACME, cookie, origin: 'http://evil.example' },
      });
      expect(forged.statusCode).toBe(403);
      expect(forged.json().code).toBe('ORIGIN_REJECTED');
      const noOrigin = await call('POST', '/api/v1/auth/sign-out', { host: ACME, cookie, origin: false });
      expect(noOrigin.statusCode).toBe(403);
      expect((await call('GET', '/api/v1/me', { host: ACME, cookie })).statusCode).toBe(200);
    });

    it('BR-69: changing the password ends the other sessions in every school, keeping this one', async () => {
      const email = 'mutale@example.com';
      const acmeCookie = await member(ACME, tenants.acme, email, 'Mutale');
      const offer = await signIn(BETA, email);
      const joined = await call('POST', '/api/v1/me/schools/current/join', {
        host: BETA,
        body: { ticket: offer.json().ticket },
      });
      const betaCookie = cookieFrom(joined.headers['set-cookie'], SESSION)!;
      const otherAcme = await freshSession(ACME, email);

      const changed = await call('POST', '/api/v1/me/password', {
        host: ACME,
        cookie: acmeCookie,
        body: { currentPassword: PASSWORD, newPassword: 'an even longer passphrase' },
      });
      expect(changed.statusCode).toBe(204);
      expect((await call('GET', '/api/v1/me', { host: ACME, cookie: acmeCookie })).statusCode).toBe(200);
      expect((await call('GET', '/api/v1/me', { host: ACME, cookie: otherAcme })).statusCode).toBe(401);
      expect((await call('GET', '/api/v1/me', { host: BETA, cookie: betaCookie })).statusCode).toBe(401);
      expect((await signIn(BETA, email, 'an even longer passphrase')).statusCode).toBe(200);
    });

    it('BR-69: revoking a membership ends that school’s sessions only', async () => {
      const email = 'revoked@example.com';
      const learnerAcme = await member(ACME, tenants.acme, email, 'Revoked Learner');
      const offer = await signIn(BETA, email);
      const joined = await call('POST', '/api/v1/me/schools/current/join', {
        host: BETA,
        body: { ticket: offer.json().ticket },
      });
      const learnerBeta = cookieFrom(joined.headers['set-cookie'], SESSION)!;

      const adminCookie = await freshSession(ACME, 'admin1@acme.test');
      const team = teamResponseSchema.parse(
        (await call('GET', '/api/v1/admin/team', { host: ACME, cookie: adminCookie })).json(),
      );
      const target = team.members.find((m) => m.email === email)!;
      const removed = await call('DELETE', `/api/v1/admin/members/${target.membershipId}`, {
        host: ACME,
        cookie: adminCookie,
      });
      expect(removed.statusCode).toBe(204);

      expect((await call('GET', '/api/v1/me', { host: ACME, cookie: learnerAcme })).statusCode).toBe(401);
      expect((await call('GET', '/api/v1/me', { host: BETA, cookie: learnerBeta })).statusCode).toBe(200);
      // And they can't sign back in at Acme (generic failure, BR-65).
      expect((await signIn(ACME, email)).statusCode).toBe(401);
    });

    it('BR-58: the last owner can be neither removed nor demoted', async () => {
      await member(ACME, tenants.acme, 'owner@acme.test', 'Acme Owner');
      await grantRole(tenants.acme, 'owner@acme.test', 'TENANT_OWNER');
      const ownerCookie = await freshSession(ACME, 'owner@acme.test');
      const me = meResponseSchema.parse(
        (await call('GET', '/api/v1/me', { host: ACME, cookie: ownerCookie })).json(),
      );
      const demote = await call('PUT', `/api/v1/admin/members/${me.membership.id}/roles`, {
        host: ACME,
        cookie: ownerCookie,
        body: { roles: ['LEARNER'] },
      });
      expect(demote.json().code).toBe('LAST_OWNER');
      const leave = await call('POST', '/api/v1/me/schools/current/leave', {
        host: ACME,
        cookie: ownerCookie,
      });
      expect(leave.json().code).toBe('LAST_OWNER');
      // Defence in depth: the database refuses it even if the application check were skipped.
      await expect(
        asTenant(tenants.acme, () =>
          migrator.query(`DELETE FROM membership_role WHERE tenant_id = $1 AND role = 'TENANT_OWNER'`, [
            tenants.acme,
          ]),
        ),
      ).rejects.toThrow(/BR-58/);
    });
  });

  describe('school switching (BR-68)', () => {
    it('hands off once, within 60 s, only to the target school', async () => {
      const acmeCookie = await freshSession(ACME, 'chanda@example.com');
      const created = await call('POST', `/api/v1/me/schools/${tenants.beta}/handoff`, {
        host: ACME,
        cookie: acmeCookie,
      });
      expect(created.statusCode).toBe(200);
      const url = created.json().url as string;
      expect(url).toMatch(/^http:\/\/beta\.localhost:3000\/switch#token=/);
      const token = tokenOf(url);

      // Wrong school: refused, and the token is not consumed.
      expect((await call('POST', '/api/v1/auth/handoff', { host: ACME, body: { token } })).statusCode).toBe(
        400,
      );
      const exchanged = await call('POST', '/api/v1/auth/handoff', { host: BETA, body: { token } });
      expect(exchanged.statusCode).toBe(200);
      const betaCookie = cookieFrom(exchanged.headers['set-cookie'], SESSION)!;
      expect((await call('GET', '/api/v1/me', { host: BETA, cookie: betaCookie })).statusCode).toBe(200);
      // Single use.
      expect((await call('POST', '/api/v1/auth/handoff', { host: BETA, body: { token } })).statusCode).toBe(
        400,
      );
    });

    it('refuses a hand-off to a school the person does not belong to', async () => {
      const adminCookie = await freshSession(ACME, 'admin1@acme.test');
      const created = await call('POST', `/api/v1/me/schools/${tenants.beta}/handoff`, {
        host: ACME,
        cookie: adminCookie,
      });
      expect(created.statusCode).toBe(404);
    });
  });

  describe('invitations (BR-67) and password reset', () => {
    it('creates the account, membership and role in one step for a new person', async () => {
      const adminCookie = await freshSession(ACME, 'admin1@acme.test');
      const invited = await call('POST', '/api/v1/admin/invitations', {
        host: ACME,
        cookie: adminCookie,
        body: { email: 'new-tutor@example.com', role: 'INSTRUCTOR' },
      });
      expect(invited.statusCode).toBe(201);
      const token = tokenOf((await lastEmail(tenants.acme, 'new-tutor@example.com', 'invitation')).link);
      const preview = await call('GET', `/api/v1/invitations/preview?token=${token}`, { host: ACME });
      expect(preview.json()).toEqual({
        schoolName: 'Acme Academy',
        email: 'new-tutor@example.com',
        role: 'INSTRUCTOR',
        accountExists: false,
      });
      // The invitation belongs to Acme: Beta's host can't see it.
      expect(
        (await call('GET', `/api/v1/invitations/preview?token=${token}`, { host: BETA })).statusCode,
      ).toBe(400);

      const accepted = await call('POST', '/api/v1/invitations/accept', {
        host: ACME,
        body: { token, displayName: 'New Tutor', password: PASSWORD },
      });
      expect(accepted.statusCode).toBe(200);
      const cookie = cookieFrom(accepted.headers['set-cookie'], SESSION)!;
      const me = meResponseSchema.parse((await call('GET', '/api/v1/me', { host: ACME, cookie })).json());
      expect(me.membership.roles.sort()).toEqual(['INSTRUCTOR', 'LEARNER']);
      expect(me.user.emailVerified).toBe(true);
      expect(me.allowedActions).toContain('studio.access');
      // Single use.
      expect(
        (
          await call('POST', '/api/v1/invitations/accept', {
            host: ACME,
            body: { token, displayName: 'X', password: PASSWORD },
          })
        ).statusCode,
      ).toBe(400);
    });

    it('requires the existing account password to accept for an existing person', async () => {
      const adminCookie = await freshSession(ACME, 'admin1@acme.test');
      await call('POST', '/api/v1/admin/invitations', {
        host: ACME,
        cookie: adminCookie,
        body: { email: 'only-beta@example.com', role: 'INSTRUCTOR' },
      });
      const token = tokenOf((await lastEmail(tenants.acme, 'only-beta@example.com', 'invitation')).link);
      expect(
        (
          await call('POST', '/api/v1/invitations/accept', {
            host: ACME,
            body: { token, password: 'wrong password!' },
          })
        ).statusCode,
      ).toBe(401);
      const accepted = await call('POST', '/api/v1/invitations/accept', {
        host: ACME,
        body: { token, password: PASSWORD },
      });
      expect(accepted.statusCode).toBe(200);
    });

    it('resets a password by single-use link and signs the person out everywhere', async () => {
      const cookie = await freshSession(ACME, 'admin1@acme.test');
      const unknown = await call('POST', '/api/v1/auth/password/forgot', {
        host: ACME,
        body: { email: 'nobody@example.com' },
      });
      const known = await call('POST', '/api/v1/auth/password/forgot', {
        host: ACME,
        body: { email: 'admin1@acme.test' },
      });
      expect(unknown.statusCode).toBe(202);
      expect(known.json()).toEqual(unknown.json());
      const token = tokenOf((await lastEmail(tenants.acme, 'admin1@acme.test', 'reset-password')).link);
      // A rejected password doesn't burn the link.
      expect(
        (
          await call('POST', '/api/v1/auth/password/reset', {
            host: ACME,
            body: { token, password: 'password123' },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await call('POST', '/api/v1/auth/password/reset', {
            host: ACME,
            body: { token, password: 'reset to this passphrase' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call('POST', '/api/v1/auth/password/reset', {
            host: ACME,
            body: { token, password: 'reset to this passphrase' },
          })
        ).statusCode,
      ).toBe(400);
      expect((await call('GET', '/api/v1/me', { host: ACME, cookie })).statusCode).toBe(401);
      expect((await signIn(ACME, 'admin1@acme.test', 'reset to this passphrase')).statusCode).toBe(200);
      // Restore for later tests.
      await call('POST', '/api/v1/auth/password/forgot', { host: ACME, body: { email: 'admin1@acme.test' } });
      const again = tokenOf((await lastEmail(tenants.acme, 'admin1@acme.test', 'reset-password')).link);
      await call('POST', '/api/v1/auth/password/reset', {
        host: ACME,
        body: { token: again, password: PASSWORD },
      });
    });

    it('stores links in queued emails encrypted, never in clear text', async () => {
      const { rows } = await asTenant(tenants.acme, () =>
        migrator.query<{ payload: unknown }>(`SELECT payload FROM outbox WHERE topic = 'email.send'`),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toMatch(/token=|https?:\/\//);
    });
  });

  describe('platform console realm (ADR-0017)', () => {
    const staff = { owner: 'owner@platform.test', operator: 'operator@platform.test' };

    async function createStaff(email: string, role: string): Promise<void> {
      const hash = await hashPassword(PASSWORD);
      await migrator.query('BEGIN');
      await migrator.query(`SELECT set_config('app.realm', 'platform', true)`);
      const { rows } = await migrator.query<{ id: string }>(
        `INSERT INTO platform_user (email, display_name, role) VALUES ($1, $1, $2::"PlatformRole") RETURNING id`,
        [email, role],
      );
      await migrator.query(`INSERT INTO platform_credential (user_id, password_hash) VALUES ($1, $2)`, [
        rows[0]!.id,
        hash,
      ]);
      await migrator.query('COMMIT');
    }

    /** Signs in with password, enrols TOTP and returns a fully verified console cookie. */
    async function consoleSession(email: string): Promise<{ cookie: string; secret: Buffer }> {
      const signedIn = await call('POST', '/console/auth/sign-in', {
        host: CONSOLE,
        body: { email, password: PASSWORD },
      });
      expect(signedIn.json()).toEqual({ next: 'ENROL_TOTP' });
      const cookie = cookieFrom(signedIn.headers['set-cookie'], CONSOLE_COOKIE)!;
      const setup = await call('POST', '/console/auth/totp/setup', { host: CONSOLE, cookie });
      const secret = Buffer.from(base32Decode(setup.json().secret));
      const enabled = await call('POST', '/console/auth/totp/enable', {
        host: CONSOLE,
        cookie,
        body: { code: totpCode(secret, timeStep()) },
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      expect(enabled.json().recoveryCodes).toHaveLength(8);
      return { cookie, secret };
    }

    beforeAll(async () => {
      await createStaff(staff.owner, 'PLATFORM_OWNER');
      await createStaff(staff.operator, 'PLATFORM_OPERATOR');
    });

    it('M4 AC 4: the console requires TOTP and re-authentication for sensitive actions', async () => {
      const signedIn = await call('POST', '/console/auth/sign-in', {
        host: CONSOLE,
        body: { email: staff.owner, password: PASSWORD },
      });
      const partial = cookieFrom(signedIn.headers['set-cookie'], CONSOLE_COOKIE)!;
      const before = await call('GET', '/console/me', { host: CONSOLE, cookie: partial });
      expect(before.statusCode).toBe(401);
      expect(before.json().code).toBe('MFA_REQUIRED');

      const setup = await call('POST', '/console/auth/totp/setup', { host: CONSOLE, cookie: partial });
      const secret = Buffer.from(base32Decode(setup.json().secret));
      expect(setup.json().otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      const wrong = await call('POST', '/console/auth/totp/enable', {
        host: CONSOLE,
        cookie: partial,
        body: { code: '000000' },
      });
      expect(wrong.statusCode).toBe(422);
      const step = timeStep();
      await call('POST', '/console/auth/totp/enable', {
        host: CONSOLE,
        cookie: partial,
        body: { code: totpCode(secret, step) },
      });
      expect((await call('GET', '/console/me', { host: CONSOLE, cookie: partial })).statusCode).toBe(200);

      // Re-authentication expires: simulate 10 minutes passing.
      await migrator.query('BEGIN');
      await migrator.query(`SELECT set_config('app.realm', 'platform', true)`);
      await migrator.query(`UPDATE platform_session SET reauth_at = now() - interval '10 minutes'`);
      await migrator.query('COMMIT');
      const stale = await call('POST', `/console/staff/${MISSING}/disable`, {
        host: CONSOLE,
        cookie: partial,
      });
      expect(stale.json().code).toBe('REAUTH_REQUIRED');

      // The same code can't be replayed; the next time step's code works.
      const replay = await call('POST', '/console/auth/reauth', {
        host: CONSOLE,
        cookie: partial,
        body: { code: totpCode(secret, step) },
      });
      expect(replay.statusCode).toBe(422);
      const reauth = await call('POST', '/console/auth/reauth', {
        host: CONSOLE,
        cookie: partial,
        body: { code: totpCode(secret, step + 1) },
      });
      expect(reauth.statusCode).toBe(204);
      expect(
        (await call('POST', `/console/staff/${MISSING}/disable`, { host: CONSOLE, cookie: partial }))
          .statusCode,
      ).toBe(404);
    });

    it('M4 AC 3: neither realm can use the other’s area', async () => {
      const schoolCookie = await freshSession(ACME, 'owner@acme.test');
      const { cookie: consoleCookie } = await consoleSession(staff.operator);

      // Console API on a school host does not exist.
      expect((await call('GET', '/console/me', { host: ACME, cookie: consoleCookie })).statusCode).toBe(404);
      // A school session means nothing on the console host, and vice versa.
      expect(
        (
          await call('GET', '/console/me', {
            host: CONSOLE,
            cookie: schoolCookie.replace(SESSION, CONSOLE_COOKIE),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await call('GET', '/api/v1/me', {
            host: ACME,
            cookie: consoleCookie.replace(CONSOLE_COOKIE, SESSION),
          })
        ).statusCode,
      ).toBe(401);
      // Platform tables are invisible in a school's database context.
      const visible = await asTenant(tenants.acme, () => migrator.query(`SELECT 1 FROM platform_user`));
      expect(visible.rowCount).toBe(0);
    });
  });

  describe('M4 AC 5: authorization matrix', () => {
    const cookies = {} as Record<TenantMatrixActor, string | undefined>;
    let otherMembership = '';

    beforeAll(async () => {
      cookies.anonymous = undefined;
      cookies.learner = await member(ACME, tenants.acme, 'matrix-learner@example.com');
      await member(ACME, tenants.acme, 'matrix-instructor@example.com');
      await grantRole(tenants.acme, 'matrix-instructor@example.com', 'INSTRUCTOR');
      cookies.instructor = await freshSession(ACME, 'matrix-instructor@example.com');
      cookies.admin = await freshSession(ACME, 'admin1@acme.test');
      cookies.owner = await freshSession(ACME, 'owner@acme.test');
      await member(BETA, tenants.beta, 'matrix-beta-owner@example.com');
      await grantRole(tenants.beta, 'matrix-beta-owner@example.com', 'TENANT_OWNER');
      cookies.otherSchool = await freshSession(BETA, 'matrix-beta-owner@example.com');
      const betaMe = meResponseSchema.parse(
        (await call('GET', '/api/v1/me', { host: BETA, cookie: cookies.otherSchool })).json(),
      );
      otherMembership = betaMe.membership.id;
      const signedIn = await call('POST', '/console/auth/sign-in', {
        host: CONSOLE,
        body: { email: 'owner@platform.test', password: PASSWORD },
      });
      cookies.staff = cookieFrom(signedIn.headers['set-cookie'], CONSOLE_COOKIE)?.replace(
        CONSOLE_COOKIE,
        SESSION,
      );
    });

    for (const row of TENANT_AUTHZ_MATRIX) {
      for (const [actor, expected] of Object.entries(row.expect) as [TenantMatrixActor, number][]) {
        it(`${row.method} ${row.path} as ${actor} → ${expected}`, async () => {
          const path = row.path
            .replaceAll('{missing}', MISSING)
            .replaceAll('{otherMembership}', otherMembership);
          const response = await call(row.method, path, {
            host: ACME,
            cookie: cookies[actor],
            body: row.body,
          });
          expect(response.statusCode, response.body).toBe(expected);
        });
      }
    }

    describe('console matrix', () => {
      const consoleCookies = {} as Record<ConsoleMatrixActor, string | undefined>;

      beforeAll(async () => {
        consoleCookies.anonymous = undefined;
        consoleCookies.schoolSession = cookies.owner;
        const partial = await call('POST', '/console/auth/sign-in', {
          host: CONSOLE,
          body: { email: 'owner@platform.test', password: PASSWORD },
        });
        consoleCookies.partialStaff = cookieFrom(partial.headers['set-cookie'], CONSOLE_COOKIE);
        const operator = await call('POST', '/console/auth/sign-in', {
          host: CONSOLE,
          body: { email: 'operator@platform.test', password: PASSWORD },
        });
        consoleCookies.operator = cookieFrom(operator.headers['set-cookie'], CONSOLE_COOKIE);
        const owner = await call('POST', '/console/auth/sign-in', {
          host: CONSOLE,
          body: { email: 'owner@platform.test', password: PASSWORD },
        });
        consoleCookies.owner = cookieFrom(owner.headers['set-cookie'], CONSOLE_COOKIE);
        // Mark both as TOTP-verified and freshly re-authenticated (the TOTP flow itself is tested in AC 4).
        await migrator.query('BEGIN');
        await migrator.query(`SELECT set_config('app.realm', 'platform', true)`);
        await migrator.query(
          `UPDATE platform_session SET mfa_verified_at = now(), reauth_at = now(), idle_expires_at = now() + interval '30 minutes'
            WHERE token_hash = ANY($1::bytea[])`,
          [[consoleCookies.operator!, consoleCookies.owner!].map((c) => sha256(c.split('=')[1]!))],
        );
        await migrator.query('COMMIT');
      });

      for (const row of CONSOLE_AUTHZ_MATRIX) {
        for (const [actor, expected] of Object.entries(row.expect) as [ConsoleMatrixActor, number][]) {
          it(`${row.method} ${row.path} as ${actor} → ${expected}`, async () => {
            const cookie = consoleCookies[actor];
            const response = await call(row.method, row.path.replace('{missing}', MISSING), {
              host: CONSOLE,
              cookie: actor === 'schoolSession' ? cookie?.replace(SESSION, CONSOLE_COOKIE) : cookie,
              body: row.body,
            });
            expect(response.statusCode, response.body).toBe(expected);
          });
        }
      }
    });
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

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
