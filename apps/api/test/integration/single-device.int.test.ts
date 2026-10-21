import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEV_IDENTITY_ENCRYPTION_KEY, SecretBox } from '../../src/modules/platform';
import { type Harness, PASSWORD, SCHOOLS, startHarness } from '../setup/school-harness';

const { acme: ACME } = SCHOOLS;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses

const PHONE =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

/** One device at a time for learners (docs/design/single-device-learners.md). */
describe('one device at a time for learners', () => {
  let h: Harness;
  const box = new SecretBox(DEV_IDENTITY_ENCRYPTION_KEY);
  let owner = '';

  const sql = (text: string, params: unknown[] = []) =>
    h.asTenant(h.tenants.acme, () => h.migrator.query(text, params));
  const me = (cookie: string) => h.call('GET', '/api/v1/me', { host: ACME, cookie });
  const signInFrom = async (email: string, userAgent: string): Promise<string> => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      remoteAddress: '127.0.0.1',
      headers: {
        host: ACME,
        origin: `http://${ACME}`,
        'content-type': 'application/json',
        'user-agent': userAgent,
      },
      payload: JSON.stringify({ email, password: PASSWORD }),
    });
    const cookie = /(__Host-sh_session=[^;]+)/.exec(String(response.headers['set-cookie']))?.[1];
    if (cookie === undefined) throw new Error(`sign-in failed: ${response.body}`);
    return cookie;
  };
  const emails = async (to: string) => {
    const { rows } = await sql(
      `SELECT payload FROM outbox WHERE topic = 'email.send' AND payload->>'template' = 'signed-in-elsewhere'
         AND payload->>'to' = $1 ORDER BY id`,
      [to],
    );
    return rows.map(
      (row: Json) => JSON.parse(box.openText(row.payload.sealed, `email:${h.tenants.acme}:${to}`)) as Json,
    );
  };

  beforeAll(async () => {
    h = await startHarness();
    owner = await h.member(ACME, h.tenants.acme, 'owner@acme.test', 'Olu Owner');
    await h.grantRole(h.tenants.acme, 'owner@acme.test', 'TENANT_OWNER');
    owner = await h.signIn(ACME, 'owner@acme.test');
    await h.member(ACME, h.tenants.acme, 'learner@example.com', 'Lina Learner');
    await h.member(ACME, h.tenants.acme, 'tutor@acme.test', 'Tiko Tutor');
    await h.grantRole(h.tenants.acme, 'tutor@acme.test', 'INSTRUCTOR');
  }, 240_000);

  afterAll(async () => {
    await h?.close();
  });

  it('a learner’s new sign-in signs out the other device, which is told why', async () => {
    const first = await h.signIn(ACME, 'learner@example.com');
    expect((await me(first)).statusCode).toBe(200);
    const second = await signInFrom('learner@example.com', PHONE);

    const refused = await me(first);
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['x-studyhub-session-ended']).toBe('replaced');
    expect(String(refused.headers['set-cookie'])).toContain('__Host-sh_session=;');
    // It stays signed out; the new device carries on, and sees one device.
    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(200);
    const sessions = await h.call('GET', '/api/v1/me/sessions', { host: ACME, cookie: second });
    expect(sessions.json().sessions).toHaveLength(1);

    const email = (await emails('learner@example.com')).at(-1);
    expect(email).toMatchObject({ detail: 'Chrome on Android' });
    const audit = await sql(
      `SELECT after FROM audit_log WHERE action = 'auth.sessions_replaced' ORDER BY created_at DESC`,
    );
    expect(audit.rows[0].after).toMatchObject({ replaced: 1, device: 'Chrome on Android' });

    // An ordinary sign-out is not "replaced".
    await h.call('POST', '/api/v1/auth/sign-out', { host: ACME, cookie: second });
    expect((await me(second)).headers['x-studyhub-session-ended']).toBeUndefined();
  });

  it('instructors and administrators keep several devices', async () => {
    const laptop = await h.signIn(ACME, 'tutor@acme.test');
    const phone = await h.signIn(ACME, 'tutor@acme.test');
    expect((await me(laptop)).statusCode).toBe(200);
    expect((await me(phone)).statusCode).toBe(200);
    const again = await h.signIn(ACME, 'owner@acme.test');
    expect((await me(owner)).statusCode).toBe(200);
    expect((await me(again)).statusCode).toBe(200);
    expect(await emails('tutor@acme.test')).toEqual([]);
  });

  it('a school can turn it off (audited); then learners keep several devices', async () => {
    const settings = await h.call('GET', '/api/v1/admin/settings', { host: ACME, cookie: owner });
    expect(settings.json().general.singleDeviceLearners).toBe(true);
    const off = await h.call('PATCH', '/api/v1/admin/settings', {
      host: ACME,
      cookie: owner,
      body: { singleDeviceLearners: false, reason: 'Shared family tablets' },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().general.singleDeviceLearners).toBe(false);

    const first = await h.signIn(ACME, 'learner@example.com');
    const second = await h.signIn(ACME, 'learner@example.com');
    expect((await me(first)).statusCode).toBe(200);
    expect((await me(second)).statusCode).toBe(200);

    const audit = await sql(
      `SELECT after FROM audit_log WHERE action = 'settings.updated' ORDER BY created_at DESC`,
    );
    expect(audit.rows[0].after).toMatchObject({
      changes: { singleDeviceLearners: { from: true, to: false } },
      reason: 'Shared family tablets',
    });
  });
});
