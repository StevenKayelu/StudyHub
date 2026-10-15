import { randomUUID } from 'node:crypto';

import { FAKE_PROFILES } from '@studyhub/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../src/modules/audit';
import {
  checkLedger,
  type CommerceDeps,
  createLedgerCheckHandler,
  createLedgerReleaseHandler,
  createOrderExpireHandler,
  createPaymentCheckHandler,
  createPaymentEventHandler,
  FAKE_PAY_SIGNATURE_HEADER,
  FAKE_PROFILE_CAPABILITIES,
  FakePaymentProvider,
  LEDGER_CHECK_JOB,
  LEDGER_RELEASE_JOB,
  ORDER_EXPIRE_JOB,
  PAYMENT_CHECK_JOB,
  PAYMENT_EVENT_JOB,
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from '../../src/modules/commerce';
import {
  createLogger,
  DEV_IDENTITY_ENCRYPTION_KEY,
  type JobEnvelope,
  PrismaService,
  runWithContext,
  SecretBox,
} from '../../src/modules/platform';
import { type Harness, SCHOOLS, startHarness } from '../setup/school-harness';

const { acme: ACME, beta: BETA } = SCHOOLS;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses

const PRICE = 25_000;
// The fake's fee is 2.5 % (625), the school keeps 20 % (5000): the instructor nets 19 375 (BR-14).
const SALE = { gross: 25_000, fee: 625, commission: 5000, net: 19_375 };
const SECRETS = ['acme-api-key-SECRET', 'acme-webhook-SECRET-0123456789', 'beta-api-key-SECRET'];
const year = Number(
  new Intl.DateTimeFormat('en', { timeZone: 'Africa/Lusaka', year: 'numeric' }).format(new Date()),
);

describe('commerce, payment accounts and ledger (M8)', () => {
  let h: Harness;
  let fake: FakePaymentProvider;
  let deps: CommerceDeps;
  const silent = createLogger({ level: 'silent' });
  const cookies: Record<string, string> = {};
  const courses = { acme: '', acmeFree: '', beta: '' };
  const accounts = { acme: '', betaMobile: '', beta: '' };
  let ip = 1;

  /** Like the harness call, plus extra headers (Idempotency-Key, webhook signatures) and raw bodies. */
  const req = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options: {
      host?: string;
      cookie?: string;
      body?: unknown;
      raw?: Buffer;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const host = options.host ?? ACME;
    return h.app.inject({
      method,
      url,
      remoteAddress: '127.0.0.1',
      headers: {
        host,
        'x-forwarded-for': `203.0.113.${(ip++ % 250) + 1}`,
        ...(options.cookie !== undefined && { cookie: options.cookie }),
        ...(method !== 'GET' && { origin: `http://${host}` }),
        ...((options.body !== undefined || options.raw !== undefined) && {
          'content-type': 'application/json',
        }),
        ...options.headers,
      },
      ...(options.body !== undefined && { payload: JSON.stringify(options.body) }),
      ...(options.raw !== undefined && { payload: options.raw }),
    });
  };
  const ok = async (response: Awaited<ReturnType<typeof req>>, status = 200): Promise<Json> => {
    expect(response.statusCode, response.body).toBe(status);
    return response.json();
  };
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

  const handlers: Record<string, (envelope: JobEnvelope, logger: typeof silent) => Promise<unknown>> = {};

  /**
   * Runs the school's due commerce outbox rows through the worker handlers, in that school's context,
   * until none are left. `force` makes delayed rows of these topics due now (time travel for W5, BR-08).
   */
  async function drain(tenantId: string, force: string[] = []): Promise<number> {
    let ran = 0;
    for (let round = 0; round < 10; round += 1) {
      const { rows } = await sql(
        tenantId,
        `SELECT id, topic, payload FROM outbox
          WHERE dispatched_at IS NULL AND topic LIKE 'commerce.%'
            AND (available_at <= now() OR topic = ANY($1::text[]))
          ORDER BY id`,
        [force],
      );
      if (rows.length === 0) return ran;
      for (const row of rows) {
        await sql(tenantId, `UPDATE outbox SET dispatched_at = now() WHERE id = $1`, [row.id]);
        await runWithContext({ requestId: `test_${row.id}`, tenantId }, () =>
          handlers[row.topic]!(
            { type: row.topic, tenantId, payload: row.payload, requestId: 'test' },
            silent,
          ),
        );
        ran += 1;
      }
      force = []; // rescheduled checks stay delayed
    }
    return ran;
  }

  async function createCourse(
    tenantId: string,
    ownerEmail: string,
    slug: string,
    price: number,
  ): Promise<string> {
    const owner = await membershipOf(tenantId, ownerEmail);
    return (
      await sql(
        tenantId,
        `INSERT INTO course (tenant_id, owner_membership_id, slug, title, status, first_published_at, published_at,
           price_minor, currency)
         VALUES ($1, $2, $3, $4, 'PUBLISHED', now(), now(), $5, 'ZMW') RETURNING id`,
        [tenantId, owner, slug, `Course ${slug}`, price],
      )
    ).rows[0].id as string;
  }

  /** Connects, tests and activates a fake account; returns its id. */
  async function connect(host: string, owner: string, label: string, credentials: Json): Promise<string> {
    const created = await ok(
      await req('POST', '/api/v1/admin/payment-accounts', {
        host,
        cookie: owner,
        body: { provider: 'fake', label, credentials },
      }),
      201,
    );
    const tested = await ok(
      await req('POST', `/api/v1/admin/payment-accounts/${created.id}/test`, { host, cookie: owner }),
    );
    expect(tested.lastTestResult).toBe('OK');
    await ok(
      await req('POST', `/api/v1/admin/payment-accounts/${created.id}/activate`, { host, cookie: owner }),
    );
    return created.id as string;
  }

  async function order(cookie: string, courseId: string, host: string = ACME, key?: string): Promise<Json> {
    const response = await req('POST', '/api/v1/orders', {
      host,
      cookie,
      body: { courseId },
      ...(key !== undefined && { headers: { 'idempotency-key': key } }),
    });
    expect([200, 201], response.body).toContain(response.statusCode);
    return response.json();
  }

  async function pay(cookie: string, orderId: string, body: Json, host: string = ACME, key?: string) {
    return req('POST', `/api/v1/orders/${orderId}/payments`, {
      host,
      cookie,
      body,
      ...(key !== undefined && { headers: { 'idempotency-key': key } }),
    });
  }

  const paymentRow = async (tenantId: string, paymentId: string): Promise<Json> =>
    (await sql(tenantId, `SELECT * FROM payment WHERE id = $1`, [paymentId])).rows[0];
  const orderRow = async (tenantId: string, orderId: string): Promise<Json> =>
    (await sql(tenantId, `SELECT * FROM "order" WHERE id = $1`, [orderId])).rows[0];
  const enrollments = async (tenantId: string, courseId: string, email: string) =>
    (
      await sql(
        tenantId,
        `SELECT e.* FROM enrollment e JOIN tenant_membership m ON m.id = e.membership_id
           JOIN user_account a ON a.id = m.user_id WHERE e.course_id = $1 AND a.email = $2`,
        [courseId, email],
      )
    ).rows;

  /** Signs a webhook for a transaction (the provider's own delivery) and posts it to an account path. */
  async function deliver(transactionId: string, eventId?: string, accountPath?: string) {
    const delivery = (await fake.webhookFor(transactionId, eventId))!;
    return req('POST', `/api/v1/webhooks/payments/fake/${accountPath ?? delivery.accountId}`, {
      raw: delivery.body,
      headers: delivery.headers,
    });
  }

  beforeAll(async () => {
    h = await startHarness();
    const gateway = h.app.get<PaymentGateway>(PAYMENT_GATEWAY);
    fake = gateway.provider('fake') as FakePaymentProvider;
    deps = {
      prisma: h.app.get(PrismaService),
      gateway,
      box: new SecretBox(DEV_IDENTITY_ENCRYPTION_KEY),
      schoolUrlTemplate: 'http://{host}:3000',
      audit: new AuditService(),
    };
    Object.assign(handlers, {
      [PAYMENT_EVENT_JOB]: createPaymentEventHandler(deps),
      [PAYMENT_CHECK_JOB]: createPaymentCheckHandler(deps),
      [ORDER_EXPIRE_JOB]: createOrderExpireHandler(deps),
      [LEDGER_RELEASE_JOB]: createLedgerReleaseHandler(deps),
      [LEDGER_CHECK_JOB]: createLedgerCheckHandler(deps),
    });

    for (const [email, role, name] of [
      ['owner@acme.test', 'TENANT_OWNER', 'Olu Owner'],
      ['admin@acme.test', 'TENANT_ADMIN', 'Ada Admin'],
      ['tutor@acme.test', 'INSTRUCTOR', 'Tiko Phiri'],
    ] as const) {
      await h.member(ACME, h.tenants.acme, email, name);
      await h.grantRole(h.tenants.acme, email, role);
      cookies[email] = await h.signIn(ACME, email);
    }
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      cookies[`l${n}@example.com`] = await h.member(
        ACME,
        h.tenants.acme,
        `l${n}@example.com`,
        `Learner ${n}`,
      );
    }
    await h.member(BETA, h.tenants.beta, 'owner@beta.test', 'Beth Owner');
    await h.grantRole(h.tenants.beta, 'owner@beta.test', 'TENANT_OWNER');
    cookies['owner@beta.test'] = await h.signIn(BETA, 'owner@beta.test');
    await h.member(BETA, h.tenants.beta, 'tutor@beta.test', 'Beta Tutor');
    await h.grantRole(h.tenants.beta, 'tutor@beta.test', 'INSTRUCTOR');
    cookies['b1@example.com'] = await h.member(BETA, h.tenants.beta, 'b1@example.com', 'Beta Learner');

    const tutor = await membershipOf(h.tenants.acme, 'tutor@acme.test');
    await sql(
      h.tenants.acme,
      `INSERT INTO instructor_profile (membership_id, tenant_id, slug, display_name, status)
       VALUES ($1, $2, 'tiko', 'Tiko Phiri', 'APPROVED')`,
      [tutor, h.tenants.acme],
    );
    courses.acme = await createCourse(h.tenants.acme, 'tutor@acme.test', 'algebra-pro', PRICE);
    courses.acmeFree = await createCourse(h.tenants.acme, 'tutor@acme.test', 'free-intro', 0);
    courses.beta = await createCourse(h.tenants.beta, 'tutor@beta.test', 'beta-paid', 15_000);
    // Acme shares revenue with instructors; earnings are available at once (window 0) so payouts can run.
    await sql(
      h.tenants.acme,
      `INSERT INTO tenant_feature (tenant_id, feature_key, enabled_by_tenant) VALUES ($1, 'instructorRevenueShare', true)`,
      [h.tenants.acme],
    );
    await h.setSetting(h.tenants.acme, 'refundWindowDays', 0);
  }, 240_000);

  afterAll(async () => {
    await h?.close();
  });

  // -------------------------------------------------------------------------------------------
  // F45: payment accounts
  // -------------------------------------------------------------------------------------------

  it('F45: only owners connect accounts; credentials are write-only and never returned (AC 4)', async () => {
    const body = {
      provider: 'fake',
      label: 'Main account',
      credentials: {
        merchantId: 'acme-merchant-0001',
        apiKey: 'acme-api-key-SECRET',
        webhookSecret: 'acme-webhook-SECRET-0123456789',
        profile: 'FULL',
      },
    };
    expect(
      (await req('POST', '/api/v1/admin/payment-accounts', { cookie: cookies['admin@acme.test']!, body }))
        .statusCode,
    ).toBe(403);
    expect(
      (await req('POST', '/api/v1/admin/payment-accounts', { cookie: cookies['l1@example.com']!, body }))
        .statusCode,
    ).toBe(403);

    // Before any account: nothing can be bought (BR-54).
    const blocked = await req('POST', '/api/v1/orders', {
      cookie: cookies['l1@example.com']!,
      body: { courseId: courses.acme },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('COURSE_NOT_PURCHASABLE');

    const owner = cookies['owner@acme.test']!;
    const created = await req('POST', '/api/v1/admin/payment-accounts', { cookie: owner, body });
    const tested = await req('POST', `/api/v1/admin/payment-accounts/${created.json().id}/test`, {
      cookie: owner,
    });
    const activated = await req('POST', `/api/v1/admin/payment-accounts/${created.json().id}/activate`, {
      cookie: owner,
    });
    const listed = await req('GET', '/api/v1/admin/payment-accounts', { cookie: owner });
    const caps = await req('GET', `/api/v1/admin/payment-accounts/${created.json().id}/capabilities`, {
      cookie: cookies['admin@acme.test']!,
    });
    for (const response of [created, tested, activated, listed, caps]) {
      expect(response.statusCode, response.body).toBeLessThan(300);
      for (const secret of SECRETS) expect(response.body).not.toContain(secret);
    }
    expect(created.json()).toMatchObject({
      status: 'PENDING',
      maskedHint: 'Fake provider · merchant ••••0001 · FULL',
    });
    expect(activated.json().status).toBe('ACTIVE');
    expect(tested.json().capabilities).toEqual(FAKE_PROFILE_CAPABILITIES.FULL);
    accounts.acme = created.json().id;

    // Nothing in the database or the audit trail holds the secrets in plain text.
    const stored = await sql(
      h.tenants.acme,
      `SELECT credentials_enc, webhook_secret_enc, data_key_enc FROM payment_account`,
    );
    const bytes = Buffer.concat(
      stored.rows.flatMap((r: Json) => [r.credentials_enc, r.webhook_secret_enc, r.data_key_enc]),
    ).toString('latin1');
    const audit = JSON.stringify((await sql(h.tenants.acme, `SELECT before, after FROM audit_log`)).rows);
    for (const secret of SECRETS) {
      expect(bytes).not.toContain(secret);
      expect(audit).not.toContain(secret);
    }
  });

  it('F45: a failing connection test leaves the account inactive and it can’t be activated', async () => {
    const owner = cookies['owner@acme.test']!;
    const created = await ok(
      await req('POST', '/api/v1/admin/payment-accounts', {
        cookie: owner,
        body: {
          provider: 'fake',
          label: 'Typo',
          credentials: {
            merchantId: 'acme-merchant-9',
            apiKey: 'bad-fixture-key-12345',
            webhookSecret: 'x'.repeat(20),
          },
        },
      }),
      201,
    );
    const tested = await ok(
      await req('POST', `/api/v1/admin/payment-accounts/${created.id}/test`, { cookie: owner }),
    );
    expect(tested.status).toBe('FAILED_TEST');
    expect(tested.lastTestResult).toContain('rejected');
    const activate = await req('POST', `/api/v1/admin/payment-accounts/${created.id}/activate`, {
      cookie: owner,
    });
    expect(activate.statusCode).toBe(409);
    const invalid = await req('POST', '/api/v1/admin/payment-accounts', {
      cookie: owner,
      body: { provider: 'fake', label: 'Empty', credentials: { merchantId: 'x' } },
    });
    expect(invalid.statusCode).toBe(422);
  });

  it('BR-04 / BR-54: a paid course publishes only with an active account and, with revenue share, a payout method', async () => {
    const tutor = cookies['tutor@acme.test']!;
    const checklist = async () =>
      (
        await ok(
          await req('GET', `/api/v1/studio/courses/${courses.acme}/publish-checklist`, { cookie: tutor }),
        )
      ).items.find((item: Json) => item.key === 'payments');
    expect(await checklist()).toMatchObject({
      ok: false,
      message: 'Add a payout method to sell this course',
    });
    const added = await ok(
      await req('POST', '/api/v1/me/payout-methods', {
        cookie: tutor,
        body: { type: 'MOBILE_MONEY', msisdn: '0961112233', accountName: 'Tiko Phiri' },
      }),
      201,
    );
    expect(added).toMatchObject({
      type: 'MOBILE_MONEY',
      isDefault: true,
      displayHint: 'MTN +260 96 ••• 233',
    });
    expect(JSON.stringify(added)).not.toContain('1112233');
    expect((await checklist()).ok).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // W1: checkout, webhooks, confirmation (F24–F27)
  // -------------------------------------------------------------------------------------------

  it('F25: Buy twice → one order (AC 2); the price is a snapshot (F24); return URLs grant nothing (AC 1); the phone approval confirms it (W1, W2, F27)', async () => {
    const learner = cookies['l1@example.com']!;
    const first = await order(learner, courses.acme, ACME, 'buy-key-0001');
    const replay = await order(learner, courses.acme, ACME, 'buy-key-0001');
    const again = await order(learner, courses.acme);
    expect(replay.id).toBe(first.id);
    expect(again.id).toBe(first.id); // BR-35: the pending order is reused
    const reused = await req('POST', '/api/v1/orders', {
      cookie: learner,
      body: { courseId: courses.acmeFree },
      headers: { 'idempotency-key': 'buy-key-0001' },
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(first).toMatchObject({
      status: 'PENDING',
      total: { amountMinor: PRICE, currency: 'ZMW' },
      methods: ['MOBILE_MONEY', 'CARD'],
    });

    // F24 AC: a price change leaves the pending order at its snapshot.
    await sql(h.tenants.acme, `UPDATE course SET price_minor = 30000 WHERE id = $1`, [courses.acme]);
    const started = await ok(
      await pay(
        learner,
        first.id,
        { method: 'MOBILE_MONEY', msisdn: '+260 97 123 4567' },
        ACME,
        'pay-key-0001',
      ),
      202,
    );
    await sql(h.tenants.acme, `UPDATE course SET price_minor = $2 WHERE id = $1`, [courses.acme, PRICE]);
    expect(started).toMatchObject({
      status: 'PENDING',
      nextAction: { type: 'APPROVE_ON_PHONE', network: 'AIRTEL', maskedMsisdn: '+260 97 ••• 567' },
    });
    expect((await paymentRow(h.tenants.acme, started.paymentId)).amount_minor).toBe(String(PRICE));
    // The same key returns the same payment; no second one is started.
    const repeat = await ok(
      await pay(
        learner,
        first.id,
        { method: 'MOBILE_MONEY', msisdn: '+260 97 123 4567' },
        ACME,
        'pay-key-0001',
      ),
      202,
    );
    expect(repeat.paymentId).toBe(started.paymentId);

    // F25 AC 1: the return URL and a refresh only ask the provider; the payment is still pending there.
    const back = await req(
      'GET',
      `/api/v1/payments/return?ref=${(await paymentRow(h.tenants.acme, started.paymentId)).reference}&status=success`,
      { cookie: learner },
    );
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe(`/learn/orders/${first.id}`);
    expect(
      (await ok(await req('POST', `/api/v1/orders/${first.id}/refresh`, { cookie: learner }))).status,
    ).toBe('PENDING');
    expect(await enrollments(h.tenants.acme, courses.acme, 'l1@example.com')).toHaveLength(0);
    expect((await req('GET', `/api/v1/learn/courses/${courses.acme}`, { cookie: learner })).statusCode).toBe(
      403,
    );

    // The learner approves on the (simulated) phone: the provider's signed webhook is stored, then processed.
    await ok(
      await req('POST', `/api/v1/dev/fake-pay/phone/${started.paymentId}/approve`, { cookie: learner }),
    );
    expect((await orderRow(h.tenants.acme, first.id)).status).toBe('PENDING'); // not before the worker ran
    await drain(h.tenants.acme);

    const view = await ok(await req('GET', `/api/v1/orders/${first.id}`, { cookie: learner }));
    expect(view).toMatchObject({ status: 'PAID', receiptNumber: `ACME-${year}-000001`, allowedActions: [] });
    const [enrollment] = await enrollments(h.tenants.acme, courses.acme, 'l1@example.com');
    expect(enrollment).toMatchObject({ status: 'ACTIVE', source: 'PURCHASE' });
    expect((await req('GET', `/api/v1/learn/courses/${courses.acme}`, { cookie: learner })).statusCode).toBe(
      200,
    );
    const ledger = (await sql(h.tenants.acme, `SELECT * FROM ledger_entry WHERE type = 'SALE'`)).rows;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      gross_minor: String(SALE.gross),
      provider_fee_minor: String(SALE.fee),
      commission_minor: String(SALE.commission),
      net_minor: String(SALE.net),
      status: 'AVAILABLE',
    });
    const receipt = await ok(await req('GET', `/api/v1/me/orders/${first.id}/receipt`, { cookie: learner }));
    expect(receipt).toMatchObject({
      number: `ACME-${year}-000001`,
      seller: { name: 'Acme Academy' },
      total: { amountMinor: PRICE },
      payment: { method: 'MOBILE_MONEY', network: 'AIRTEL', maskedMsisdn: '+260 97 ••• 567' },
    });
    const emails = (
      await sql(h.tenants.acme, `SELECT payload FROM outbox WHERE payload->>'template' = 'receipt'`)
    ).rows;
    expect(emails.map((e: Json) => e.payload.to)).toEqual(['l1@example.com']);
    // Another learner can't see this order or its receipt.
    expect(
      (await req('GET', `/api/v1/orders/${first.id}`, { cookie: cookies['l2@example.com']! })).statusCode,
    ).toBe(404);
    expect(
      (await req('GET', `/api/v1/me/orders/${first.id}/receipt`, { cookie: cookies['l2@example.com']! }))
        .statusCode,
    ).toBe(404);
    // Already enrolled: no new order (BR-07).
    expect(
      (await req('POST', '/api/v1/orders', { cookie: learner, body: { courseId: courses.acme } })).json()
        .code,
    ).toBe('ALREADY_ENROLLED');
  });

  it('F26 AC 1: replaying the webhook 5 times (and new event ids) yields one enrollment and one ledger entry', async () => {
    const payment = (
      await sql(h.tenants.acme, `SELECT provider_transaction_id FROM payment WHERE status = 'SUCCEEDED'`)
    ).rows[0];
    for (let i = 0; i < 5; i += 1) {
      expect((await deliver(payment.provider_transaction_id, 'replayed-event-1')).statusCode).toBe(200);
      expect((await deliver(payment.provider_transaction_id)).statusCode).toBe(200);
    }
    await drain(h.tenants.acme);
    expect(await enrollments(h.tenants.acme, courses.acme, 'l1@example.com')).toHaveLength(1);
    expect(
      (await sql(h.tenants.acme, `SELECT count(*) FROM ledger_entry WHERE type = 'SALE'`)).rows[0].count,
    ).toBe('1');
    expect((await sql(h.tenants.acme, `SELECT count(*) FROM receipt`)).rows[0].count).toBe('1');
    expect(
      (
        await sql(
          h.tenants.acme,
          `SELECT count(*) FROM payment_event WHERE provider_event_id = 'replayed-event-1'`,
        )
      ).rows[0].count,
    ).toBe('1');
  });

  it('F26 AC 2: a webhook with a bad signature is rejected (401), logged and not stored', async () => {
    const before = (await sql(h.tenants.acme, `SELECT count(*) FROM payment_event`)).rows[0].count;
    const body = Buffer.from(
      JSON.stringify({ eventId: 'forged-1', type: 'payment.updated', reference: randomUUID() }),
    );
    const forged = await req('POST', `/api/v1/webhooks/payments/fake/${accounts.acme}`, {
      raw: body,
      headers: { [FAKE_PAY_SIGNATURE_HEADER]: '00'.repeat(32) },
    });
    expect(forged.statusCode).toBe(401);
    const unsigned = await req('POST', `/api/v1/webhooks/payments/fake/${accounts.acme}`, { raw: body });
    expect(unsigned.statusCode).toBe(401);
    expect((await sql(h.tenants.acme, `SELECT count(*) FROM payment_event`)).rows[0].count).toBe(before);
    expect(
      (await req('POST', `/api/v1/webhooks/payments/fake/${randomUUID()}`, { raw: body })).statusCode,
    ).toBe(404);
    expect(
      (await req('POST', `/api/v1/webhooks/payments/other/${accounts.acme}`, { raw: body })).statusCode,
    ).toBe(404);
  });

  it('F25 AC 4: a failed payment shows its reason and the same order can be paid again (here by card, hosted page)', async () => {
    const learner = cookies['l2@example.com']!;
    const created = await order(learner, courses.acme);
    const failed = await ok(
      await pay(learner, created.id, { method: 'MOBILE_MONEY', msisdn: '0962222222' }),
      202,
    );
    expect(failed).toMatchObject({
      status: 'FAILED',
      failureCode: 'INSUFFICIENT_FUNDS',
      nextAction: { type: 'NONE' },
    });
    const view = await ok(await req('GET', `/api/v1/orders/${created.id}`, { cookie: learner }));
    expect(view).toMatchObject({
      status: 'PENDING',
      payment: { status: 'FAILED', failureCode: 'INSUFFICIENT_FUNDS' },
      allowedActions: ['pay', 'cancel'],
    });

    const card = await ok(await pay(learner, created.id, { method: 'CARD' }), 202);
    expect(card.nextAction.type).toBe('REDIRECT');
    const page = await req('GET', card.nextAction.url, { cookie: learner });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Development only');
    expect(page.body).toContain('Pay K 250.00');
    const submitted = await req('POST', `${card.nextAction.url}/approve`, {
      cookie: learner,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(submitted.statusCode).toBe(303);
    expect(submitted.headers.location).toBe(`http://acme.localhost:3000/learn/orders/${created.id}`);
    await drain(h.tenants.acme);
    expect(await ok(await req('GET', `/api/v1/orders/${created.id}`, { cookie: learner }))).toMatchObject({
      id: created.id,
      status: 'PAID',
      receiptNumber: `ACME-${year}-000002`,
    });
  });

  it('F26 AC 3: an amount mismatch goes to the exceptions queue without access; an admin accepts it', async () => {
    const learner = cookies['l3@example.com']!;
    const created = await order(learner, courses.acme);
    const started = await ok(
      await pay(learner, created.id, { method: 'MOBILE_MONEY', msisdn: '0975555555' }),
      202,
    );
    const refreshed = await ok(
      await req('POST', `/api/v1/orders/${created.id}/refresh`, { cookie: learner }),
    );
    expect(refreshed).toMatchObject({ status: 'PENDING', payment: { status: 'NEEDS_REVIEW' } });
    expect(await enrollments(h.tenants.acme, courses.acme, 'l3@example.com')).toHaveLength(0);

    const admin = cookies['admin@acme.test']!;
    const queue = await ok(await req('GET', '/api/v1/admin/payment-exceptions', { cookie: admin }));
    expect(queue.exceptions).toEqual([
      expect.objectContaining({
        paymentId: started.paymentId,
        reviewReason: 'AMOUNT_MISMATCH',
        amount: { amountMinor: PRICE, currency: 'ZMW' },
        providerAmount: { amountMinor: PRICE - 100, currency: 'ZMW' },
      }),
    ]);
    const detail = await ok(await req('GET', `/api/v1/admin/orders/${created.id}`, { cookie: admin }));
    expect(detail.allowedActions).toEqual(expect.arrayContaining(['accept', 'refund', 'recheck']));
    const accepted = await ok(
      await req('POST', `/api/v1/admin/payments/${started.paymentId}/resolve`, {
        cookie: admin,
        body: { decision: 'ACCEPT', note: 'Customer paid K249, accepted as goodwill' },
      }),
    );
    expect(accepted).toMatchObject({ status: 'SUCCEEDED', receiptNumber: `ACME-${year}-000003` });
    expect((await enrollments(h.tenants.acme, courses.acme, 'l3@example.com'))[0].status).toBe('ACTIVE');
    expect(
      (await ok(await req('GET', '/api/v1/admin/payment-exceptions', { cookie: admin }))).exceptions,
    ).toEqual([]);
    const audit = (
      await sql(h.tenants.acme, `SELECT action FROM audit_log WHERE action LIKE 'payment.%'`)
    ).rows.map((r: Json) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['payment.needs_review', 'payment.accepted']));
  });

  it('F25 AC 3: a learner who closes the browser still gets access once reconciliation confirms (W5)', async () => {
    const learner = cookies['l4@example.com']!;
    const created = await order(learner, courses.acme);
    const started = await ok(
      await pay(learner, created.id, { method: 'MOBILE_MONEY', msisdn: '0951234567' }),
      202,
    );
    const payment = await paymentRow(h.tenants.acme, started.paymentId);
    // Approved at the provider, but its webhook never arrives.
    await fake.decide(payment.provider_transaction_id, 'APPROVE');
    await drain(h.tenants.acme); // its first check is 2 min away
    expect((await orderRow(h.tenants.acme, created.id)).status).toBe('PENDING');
    await drain(h.tenants.acme, [PAYMENT_CHECK_JOB]);
    expect((await orderRow(h.tenants.acme, created.id)).status).toBe('PAID');
    expect((await enrollments(h.tenants.acme, courses.acme, 'l4@example.com'))[0].status).toBe('ACTIVE');
  });

  it('W5 / BR-08: unanswered payments back off and expire after 24 h; orders expire; a late success is still honoured', async () => {
    const learner = cookies['l5@example.com']!;
    const created = await order(learner, courses.acme);
    const started = await ok(
      await pay(learner, created.id, { method: 'MOBILE_MONEY', msisdn: '0974444444' }),
      202,
    );
    await drain(h.tenants.acme, [PAYMENT_CHECK_JOB]);
    const checked = await paymentRow(h.tenants.acme, started.paymentId);
    expect(checked).toMatchObject({ status: 'PENDING', check_count: 1 });
    expect(new Date(checked.next_check_at).getTime() - Date.now()).toBeGreaterThan(3 * 60_000); // backoff: 4 min

    await sql(h.tenants.acme, `UPDATE payment SET created_at = now() - interval '25 hours' WHERE id = $1`, [
      started.paymentId,
    ]);
    await sql(h.tenants.acme, `UPDATE "order" SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      created.id,
    ]);
    await drain(h.tenants.acme, [PAYMENT_CHECK_JOB, ORDER_EXPIRE_JOB]);
    expect((await paymentRow(h.tenants.acme, started.paymentId)).status).toBe('EXPIRED');
    expect((await orderRow(h.tenants.acme, created.id)).status).toBe('EXPIRED');
    expect((await pay(learner, created.id, { method: 'CARD' })).json().code).toBe('ORDER_NOT_PAYABLE');

    // The money arrives after all: the provider's success is honoured (EXPIRED → PAID).
    const late = await fake.decide(
      (await paymentRow(h.tenants.acme, started.paymentId)).provider_transaction_id,
      'APPROVE',
    );
    expect(
      (
        await req('POST', `/api/v1/webhooks/payments/fake/${late!.accountId}`, {
          raw: late!.body,
          headers: late!.headers,
        })
      ).statusCode,
    ).toBe(200);
    await drain(h.tenants.acme);
    expect((await orderRow(h.tenants.acme, created.id)).status).toBe('PAID');
    expect((await enrollments(h.tenants.acme, courses.acme, 'l5@example.com'))[0].status).toBe('ACTIVE');
  });

  it('F27 AC: receipt numbers are gap-free per year, even when payments confirm at the same time', async () => {
    const started: { orderId: string; transactionId: string }[] = [];
    for (const n of [6, 7, 8]) {
      const learner = cookies[`l${n}@example.com`]!;
      const created = await order(learner, courses.acme);
      const payment = await ok(
        await pay(learner, created.id, { method: 'MOBILE_MONEY', msisdn: `096000000${n}` }),
        202,
      );
      const row = await paymentRow(h.tenants.acme, payment.paymentId);
      await fake.decide(row.provider_transaction_id, 'APPROVE');
      started.push({ orderId: created.id, transactionId: row.provider_transaction_id });
    }
    // Three webhooks processed concurrently.
    await Promise.all(started.map((s) => deliver(s.transactionId)));
    const { rows } = await sql(
      h.tenants.acme,
      `SELECT id, payload FROM outbox WHERE topic = $1 AND dispatched_at IS NULL`,
      [PAYMENT_EVENT_JOB],
    );
    await sql(h.tenants.acme, `UPDATE outbox SET dispatched_at = now() WHERE topic = $1`, [
      PAYMENT_EVENT_JOB,
    ]);
    await Promise.all(
      rows.map((row: Json) =>
        runWithContext({ requestId: 'concurrent', tenantId: h.tenants.acme }, () =>
          handlers[PAYMENT_EVENT_JOB]!(
            { type: PAYMENT_EVENT_JOB, tenantId: h.tenants.acme, payload: row.payload, requestId: 'c' },
            silent,
          ),
        ),
      ),
    );
    const receipts = (
      await sql(h.tenants.acme, `SELECT number, seq FROM receipt WHERE year = $1 ORDER BY seq`, [year])
    ).rows;
    expect(receipts.map((r: Json) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(receipts.at(-1).number).toBe(`ACME-${year}-000008`);
  });

  // -------------------------------------------------------------------------------------------
  // W3, W4: payouts and refunds (F28, F29; AC 7)
  // -------------------------------------------------------------------------------------------

  it('W3: an admin records a payout of available earnings; the instructor sees it (S-AD05, S-T11)', async () => {
    const admin = cookies['admin@acme.test']!;
    const tutor = await membershipOf(h.tenants.acme, 'tutor@acme.test');
    const total = Number(
      (await sql(h.tenants.acme, `SELECT sum(net_minor) AS s FROM ledger_entry`)).rows[0].s,
    );
    // Eight sales; the accepted short payment had a slightly smaller provider fee (623).
    expect(total).toBe(SALE.net * 7 + (SALE.gross - 623 - SALE.commission));
    const balances = await ok(await req('GET', '/api/v1/admin/earnings', { cookie: admin }));
    expect(balances.instructors).toEqual([
      expect.objectContaining({
        membershipId: tutor,
        name: 'Tiko Phiri',
        available: total,
        pending: 0,
        paid: 0,
        payoutMethodHint: 'MTN +260 96 ••• 233',
      }),
    ]);
    const ledger = await ok(await req('GET', `/api/v1/admin/earnings/${tutor}`, { cookie: admin }));
    const ids = ledger.entries.map((e: Json) => e.id);
    const payout = await ok(
      await req('POST', '/api/v1/admin/payouts', {
        cookie: admin,
        body: {
          membershipId: tutor,
          entryIds: ids.slice(0, 2),
          externalReference: 'MTN-TX-1001',
          paidAt: '2026-10-15',
        },
      }),
      201,
    );
    expect(payout.amount).toEqual({ amountMinor: SALE.net * 2, currency: 'ZMW' });
    const mine = await ok(
      await req('GET', '/api/v1/studio/earnings', { cookie: cookies['tutor@acme.test']! }),
    );
    expect(mine.balances).toEqual({
      pending: 0,
      available: total - SALE.net * 2,
      paidThisYear: SALE.net * 2,
    });
    expect(mine.payouts[0]).toMatchObject({
      externalReference: 'MTN-TX-1001',
      entryCount: 2,
      methodHint: 'MTN +260 96 ••• 233',
    });
    const csv = await req('GET', '/api/v1/studio/earnings.csv', { cookie: cookies['tutor@acme.test']! });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('date,type,course,status,gross,fee,commission,net,currency');
    expect(csv.body).toContain(',SALE,Course algebra-pro,PAID,250.00,6.25,50.00,193.75,ZMW');
    const email = (
      await sql(h.tenants.acme, `SELECT payload FROM outbox WHERE payload->>'template' = 'payout-recorded'`)
    ).rows;
    expect(email.map((e: Json) => e.payload.to)).toEqual(['tutor@acme.test']);
    // Paying the same entries twice is impossible.
    const twice = await req('POST', '/api/v1/admin/payouts', {
      cookie: admin,
      body: {
        membershipId: tutor,
        entryIds: ids.slice(0, 1),
        externalReference: 'MTN-TX-1002',
        paidAt: '2026-10-15',
      },
    });
    expect(twice.statusCode).toBe(422);
  });

  it('F28: a provider refund revokes access, reverses earnings and refunds the order, all together (BR-13)', async () => {
    const admin = cookies['admin@acme.test']!;
    const l1Order = (
      await sql(
        h.tenants.acme,
        `SELECT o.id FROM "order" o JOIN tenant_membership m ON m.id = o.membership_id JOIN user_account a ON a.id = m.user_id WHERE a.email = 'l1@example.com'`,
      )
    ).rows[0].id;
    const detail = await ok(await req('GET', `/api/v1/admin/orders/${l1Order}`, { cookie: admin }));
    expect(detail.refundGuidance).toMatchObject({ refundApi: 'FULL', defaultMode: 'MANUAL', windowDays: 0 });
    const refunded = await req('POST', `/api/v1/admin/orders/${l1Order}/refunds`, {
      cookie: admin,
      body: { mode: 'PROVIDER', reason: 'Bought by mistake' },
      headers: { 'idempotency-key': 'refund-key-0001' },
    });
    expect(refunded.statusCode, refunded.body).toBe(201);
    expect(refunded.json()).toMatchObject({ status: 'SUCCEEDED', mode: 'PROVIDER' });
    // The same key replays the outcome instead of refunding again.
    const replay = await req('POST', `/api/v1/admin/orders/${l1Order}/refunds`, {
      cookie: admin,
      body: { mode: 'PROVIDER', reason: 'Bought by mistake' },
      headers: { 'idempotency-key': 'refund-key-0001' },
    });
    expect(replay.json().refundId).toBe(refunded.json().refundId);

    expect((await orderRow(h.tenants.acme, l1Order)).status).toBe('REFUNDED');
    expect((await enrollments(h.tenants.acme, courses.acme, 'l1@example.com'))[0]).toMatchObject({
      status: 'REVOKED',
      revoke_reason: 'Refunded',
    });
    expect(
      (await req('GET', `/api/v1/learn/courses/${courses.acme}`, { cookie: cookies['l1@example.com']! }))
        .statusCode,
    ).toBe(403);
    const reversal = (await sql(h.tenants.acme, `SELECT * FROM ledger_entry WHERE type = 'REFUND_REVERSAL'`))
      .rows;
    expect(reversal).toHaveLength(1);
    // The sale was already paid out, so its reversal is available at once: a negative balance (AC 7).
    expect(reversal[0]).toMatchObject({
      net_minor: String(-SALE.net),
      gross_minor: String(-SALE.gross),
      status: 'AVAILABLE',
    });
    const templates = (
      await sql(
        h.tenants.acme,
        `SELECT payload->>'template' AS t, payload->>'to' AS to FROM outbox WHERE payload->>'template' LIKE 'refund-%'`,
      )
    ).rows;
    expect(templates).toEqual(
      expect.arrayContaining([
        { t: 'refund-learner', to: 'l1@example.com' },
        { t: 'refund-instructor', to: 'tutor@acme.test' },
      ]),
    );
  });

  it('AC 7: the negative balance carries into the next payout, which must include it', async () => {
    const admin = cookies['admin@acme.test']!;
    const tutor = await membershipOf(h.tenants.acme, 'tutor@acme.test');
    const ledger = await ok(await req('GET', `/api/v1/admin/earnings/${tutor}`, { cookie: admin }));
    const available = ledger.entries.filter((e: Json) => e.status === 'AVAILABLE');
    const negative = available.filter((e: Json) => e.net < 0).map((e: Json) => e.id);
    const positive = available.filter((e: Json) => e.net > 0).map((e: Json) => e.id);
    expect(negative).toHaveLength(1);
    const expected = available.reduce((sum: number, e: Json) => sum + (e.net as number), 0);
    const balances = await ok(await req('GET', '/api/v1/admin/earnings', { cookie: admin }));
    expect(balances.instructors[0].available).toBe(expected);
    const without = await req('POST', '/api/v1/admin/payouts', {
      cookie: admin,
      body: {
        membershipId: tutor,
        entryIds: positive,
        externalReference: 'MTN-TX-2001',
        paidAt: '2026-10-16',
      },
    });
    expect(without.statusCode).toBe(422);
    expect(without.json().errors[0].code).toBe('NEGATIVE_LEFT_OUT');
    const withIt = await ok(
      await req('POST', '/api/v1/admin/payouts', {
        cookie: admin,
        body: {
          membershipId: tutor,
          entryIds: [...positive, ...negative],
          externalReference: 'MTN-TX-2001',
          paidAt: '2026-10-16',
        },
      }),
      201,
    );
    expect(withIt.amount.amountMinor).toBe(expected);
    expect(
      (await ok(await req('GET', '/api/v1/admin/earnings', { cookie: admin }))).instructors[0].available,
    ).toBe(0);
  });

  it('F28 AC: a refund is atomic: if any part fails, nothing is recorded', async () => {
    const admin = cookies['admin@acme.test']!;
    const l3Order = (
      await sql(
        h.tenants.acme,
        `SELECT o.id FROM "order" o JOIN tenant_membership m ON m.id = o.membership_id JOIN user_account a ON a.id = m.user_id WHERE a.email = 'l3@example.com'`,
      )
    ).rows[0].id;
    // Make the ledger reversal fail inside the refund transaction.
    await h.migrator.query(`CREATE FUNCTION test_fail_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated failure'; END $$`);
    await h.migrator.query(`CREATE TRIGGER test_fail_reversal BEFORE INSERT ON ledger_entry FOR EACH ROW
      WHEN (NEW.type = 'REFUND_REVERSAL') EXECUTE FUNCTION test_fail_reversal()`);
    try {
      const failed = await req('POST', `/api/v1/admin/orders/${l3Order}/refunds`, {
        cookie: admin,
        body: { mode: 'MANUAL', reason: 'Duplicate purchase', reference: 'BANK-TRF-77' },
      });
      expect(failed.statusCode).toBe(500);
    } finally {
      await h.migrator.query('DROP TRIGGER test_fail_reversal ON ledger_entry');
      await h.migrator.query('DROP FUNCTION test_fail_reversal()');
    }
    expect((await orderRow(h.tenants.acme, l3Order)).status).toBe('PAID');
    expect(
      (await sql(h.tenants.acme, `SELECT count(*) FROM refund WHERE order_id = $1`, [l3Order])).rows[0].count,
    ).toBe('0');
    expect((await enrollments(h.tenants.acme, courses.acme, 'l3@example.com'))[0].status).toBe('ACTIVE');
    // Without the failure the same manual refund goes through.
    const done = await req('POST', `/api/v1/admin/orders/${l3Order}/refunds`, {
      cookie: admin,
      body: { mode: 'MANUAL', reason: 'Duplicate purchase', reference: 'BANK-TRF-77' },
    });
    expect(done.statusCode, done.body).toBe(201);
    expect((await orderRow(h.tenants.acme, l3Order)).status).toBe('REFUNDED');
  });

  it('F29 AC 2: ledger rows can’t be changed or deleted by the application', async () => {
    const app = await h.database.connect(h.database.appUrl);
    try {
      const attempt = async (statement: string) => {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [h.tenants.acme]);
        try {
          await app.query(statement);
          return 'ok';
        } catch (error) {
          return (error as { code?: string }).code;
        } finally {
          await app.query('ROLLBACK');
        }
      };
      expect(
        await attempt(`UPDATE ledger_entry SET net_minor = net_minor + 1, gross_minor = gross_minor + 1`),
      ).toBe('23514');
      expect(await attempt(`UPDATE ledger_entry SET status = 'PENDING' WHERE status = 'PAID'`)).toBe('23514');
      expect(await attempt(`DELETE FROM ledger_entry`)).toBe('42501');
      expect(await attempt(`DELETE FROM payout`)).toBe('42501');
    } finally {
      await app.end();
    }
  });

  it('W6 / F29 AC 1: the daily check reconciles the ledger with orders and refunds, and alerts owners on a mismatch', async () => {
    const result = await runWithContext({ requestId: 'check', tenantId: h.tenants.acme }, () =>
      checkLedger(deps),
    );
    expect(result).toMatchObject({ ok: true, mismatches: [] });
    expect(result.salesExpected).toBe(SALE.gross * 8);
    expect(result.reversalsRecorded).toBe(-SALE.gross * 2);

    // A sale without a paid order (as if written by a bug) is found and reported.
    const tutor = await membershipOf(h.tenants.acme, 'tutor@acme.test');
    const stray = await order(cookies['l9@example.com']!, courses.acme);
    const item = (await sql(h.tenants.acme, `SELECT id FROM order_item WHERE order_id = $1`, [stray.id]))
      .rows[0].id;
    await sql(
      h.tenants.acme,
      `INSERT INTO ledger_entry (tenant_id, instructor_membership_id, order_item_id, type, gross_minor, net_minor, currency, available_at)
       VALUES ($1, $2, $3, 'SALE', 100, 100, 'ZMW', now())`,
      [h.tenants.acme, tutor, item],
    );
    await runWithContext({ requestId: 'check', tenantId: h.tenants.acme }, () =>
      handlers[LEDGER_CHECK_JOB]!(
        { type: LEDGER_CHECK_JOB, tenantId: h.tenants.acme, payload: {}, requestId: 'check' },
        silent,
      ),
    );
    const stored = (
      await sql(h.tenants.acme, `SELECT ok, mismatches FROM ledger_check ORDER BY checked_at DESC LIMIT 1`)
    ).rows[0];
    expect(stored.ok).toBe(false);
    expect(stored.mismatches).toEqual(
      expect.arrayContaining([{ kind: 'SALE_WITHOUT_PAID_ORDER', id: expect.any(String) }]),
    );
    const alerts = (
      await sql(
        h.tenants.acme,
        `SELECT payload->>'to' AS to FROM outbox WHERE payload->>'template' = 'ledger-mismatch'`,
      )
    ).rows;
    expect(alerts).toEqual([{ to: 'owner@acme.test' }]);
    // The school was just checked, so the daily sweep skips it; Beta has no sales yet.
    const due = await h.app.get(PrismaService).$queryRaw<
      { tenant_id: string }[]
    >`SELECT tenant_id FROM due_ledger_checks(10)`;
    expect(due.map((d) => d.tenant_id)).not.toContain(h.tenants.acme);
  });

  // -------------------------------------------------------------------------------------------
  // Another school: capability limits, manual refunds, failure isolation, signature confusion
  // -------------------------------------------------------------------------------------------

  it('AC 8: each fake profile’s connection test reports its own capabilities', async () => {
    const owner = cookies['owner@beta.test']!;
    for (const profile of FAKE_PROFILES) {
      const created = await ok(
        await req('POST', '/api/v1/admin/payment-accounts', {
          host: BETA,
          cookie: owner,
          body: {
            provider: 'fake',
            label: profile,
            credentials: {
              merchantId: `beta-${profile}`,
              apiKey: 'beta-api-key-SECRET',
              webhookSecret: 'beta-webhook-0123456789',
              profile,
            },
          },
        }),
        201,
      );
      const tested = await ok(
        await req('POST', `/api/v1/admin/payment-accounts/${created.id}/test`, { host: BETA, cookie: owner }),
      );
      expect(tested.capabilities).toEqual(FAKE_PROFILE_CAPABILITIES[profile]);
    }
  });

  it('AC 5: methods and refund modes the account doesn’t support can’t be enabled or used (BR-62)', async () => {
    const owner = cookies['owner@beta.test']!;
    accounts.betaMobile = await connect(BETA, owner, 'Mobile only', {
      merchantId: 'beta-mobile-01',
      apiKey: 'beta-api-key-SECRET',
      webhookSecret: 'beta-webhook-0123456789',
      profile: 'MOBILE_ONLY',
    });
    const settings = await ok(await req('GET', '/api/v1/admin/settings', { host: BETA, cookie: owner }));
    expect(settings).toMatchObject({
      supported: { methods: ['MOBILE_MONEY'], refundApi: 'FULL' },
      revenueShare: false,
    });
    const refused = await req('PATCH', '/api/v1/admin/settings', {
      host: BETA,
      cookie: owner,
      body: { enabledPaymentMethods: ['MOBILE_MONEY', 'CARD'], reason: 'Take cards too' },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      code: 'PAYMENT_METHOD_NOT_SUPPORTED',
      errors: [{ field: 'enabledPaymentMethods' }],
    });
    const saved = await ok(
      await req('PATCH', '/api/v1/admin/settings', {
        host: BETA,
        cookie: owner,
        body: {
          enabledPaymentMethods: ['MOBILE_MONEY'],
          orderExpiryMinutes: 45,
          reason: 'Mobile money only',
        },
      }),
    );
    expect(saved.commerce).toMatchObject({ enabledPaymentMethods: ['MOBILE_MONEY'], orderExpiryMinutes: 45 });
    expect(saved.lastChange).toMatchObject({ by: 'Beth Owner', reason: 'Mobile money only' });

    const learner = cookies['b1@example.com']!;
    const created = await order(learner, courses.beta, BETA);
    expect(created.methods).toEqual(['MOBILE_MONEY']);
    expect(new Date(created.expiresAt).getTime() - Date.now()).toBeGreaterThan(44 * 60_000);
    const card = await pay(learner, created.id, { method: 'CARD' }, BETA);
    expect(card.statusCode).toBe(422);
    expect(card.json().code).toBe('PAYMENT_METHOD_NOT_SUPPORTED');
    const learnerSettings = await req('PATCH', '/api/v1/admin/settings', {
      host: BETA,
      cookie: learner,
      body: { reason: 'nope' },
    });
    expect(learnerSettings.statusCode).toBe(403);
  });

  it('AC 6: without a refund API, refunds are recorded manually', async () => {
    const owner = cookies['owner@beta.test']!;
    accounts.beta = await connect(BETA, owner, 'Main', {
      merchantId: 'beta-main-0001',
      apiKey: 'beta-api-key-SECRET',
      webhookSecret: 'beta-webhook-0123456789',
      profile: 'NO_REFUND_API',
    });
    const accountsList = await ok(
      await req('GET', '/api/v1/admin/payment-accounts', { host: BETA, cookie: owner }),
    );
    expect(accountsList.accounts.find((a: Json) => a.id === accounts.betaMobile).status).toBe('DISABLED');
    const providerMode = await req('PATCH', '/api/v1/admin/settings', {
      host: BETA,
      cookie: owner,
      body: { refundMode: 'PROVIDER_API', reason: 'Refund through the provider' },
    });
    expect(providerMode.statusCode).toBe(422);

    const learner = cookies['b1@example.com']!;
    const created = await order(learner, courses.beta, BETA);
    const started = await ok(
      await pay(learner, created.id, { method: 'MOBILE_MONEY', msisdn: '0971111111' }, BETA),
      202,
    );
    await ok(await req('POST', `/api/v1/orders/${created.id}/refresh`, { host: BETA, cookie: learner }));
    expect((await orderRow(h.tenants.beta, created.id)).status).toBe('PAID');
    expect((await paymentRow(h.tenants.beta, started.paymentId)).payment_account_id).toBe(accounts.beta);
    // Beta numbers its own receipts.
    expect(
      (await ok(await req('GET', `/api/v1/orders/${created.id}`, { host: BETA, cookie: learner })))
        .receiptNumber,
    ).toBe(`BETA-${year}-000001`);

    const viaProvider = await req('POST', `/api/v1/admin/orders/${created.id}/refunds`, {
      host: BETA,
      cookie: owner,
      body: { mode: 'PROVIDER', reason: 'Wrong course' },
    });
    expect(viaProvider.statusCode).toBe(422);
    expect(viaProvider.json().code).toBe('PAYMENT_METHOD_NOT_SUPPORTED');
    const manual = await req('POST', `/api/v1/admin/orders/${created.id}/refunds`, {
      host: BETA,
      cookie: owner,
      body: { mode: 'MANUAL', reason: 'Wrong course', reference: 'AIRTEL-REV-55' },
    });
    expect(manual.statusCode, manual.body).toBe(201);
    expect((await orderRow(h.tenants.beta, created.id)).status).toBe('REFUNDED');
    // No revenue share at Beta: no ledger at all.
    expect((await sql(h.tenants.beta, `SELECT count(*) FROM ledger_entry`)).rows[0].count).toBe('0');
    expect((await req('GET', '/api/v1/admin/earnings', { host: BETA, cookie: owner })).json().code).toBe(
      'FEATURE_NOT_ENABLED',
    );
  });

  it('AC 2: a webhook signed with one account’s secret can never affect another school’s orders', async () => {
    const learner = cookies['b1@example.com']!;
    const created = await order(learner, courses.beta, BETA);
    const started = await ok(
      await pay(learner, created.id, { method: 'MOBILE_MONEY', msisdn: '0961234500' }, BETA),
      202,
    );
    const betaPayment = await paymentRow(h.tenants.beta, started.paymentId);
    await fake.decide(betaPayment.provider_transaction_id, 'APPROVE'); // approved at the provider; no webhook

    // An event naming Beta's payment, correctly signed with ACME's secret, sent to Acme's account path.
    const acmeTx = (
      await sql(
        h.tenants.acme,
        `SELECT provider_transaction_id FROM payment WHERE status = 'SUCCEEDED' LIMIT 1`,
      )
    ).rows[0];
    const template = (await fake.webhookFor(acmeTx.provider_transaction_id))!;
    const body = Buffer.from(
      JSON.stringify({
        ...JSON.parse(template.body.toString()),
        eventId: 'confused-1',
        reference: betaPayment.reference,
      }),
    );
    const { createHmac } = await import('node:crypto');
    const signedByAcme = createHmac('sha256', 'acme-webhook-SECRET-0123456789').update(body).digest('hex');
    const toAcme = await req('POST', `/api/v1/webhooks/payments/fake/${accounts.acme}`, {
      raw: body,
      headers: { [FAKE_PAY_SIGNATURE_HEADER]: signedByAcme },
    });
    expect(toAcme.statusCode).toBe(200); // a valid Acme event, but it names no Acme payment
    const toBeta = await req('POST', `/api/v1/webhooks/payments/fake/${accounts.beta}`, {
      raw: body,
      headers: { [FAKE_PAY_SIGNATURE_HEADER]: signedByAcme },
    });
    expect(toBeta.statusCode).toBe(401); // Beta's account verifies with its own secret
    await drain(h.tenants.acme);
    await drain(h.tenants.beta);
    expect((await paymentRow(h.tenants.beta, started.paymentId)).status).toBe('PENDING');
    expect((await orderRow(h.tenants.beta, created.id)).status).toBe('PENDING');
    const event = (
      await sql(
        h.tenants.acme,
        `SELECT payment_id, processing_error FROM payment_event WHERE provider_event_id = 'confused-1'`,
      )
    ).rows[0];
    expect(event).toEqual({ payment_id: null, processing_error: 'UNKNOWN_REFERENCE' });

    // A job carrying Beta's payment id in Acme's context finds nothing either (threat T12).
    await runWithContext({ requestId: 'wrong', tenantId: h.tenants.acme }, () =>
      handlers[PAYMENT_CHECK_JOB]!(
        {
          type: PAYMENT_CHECK_JOB,
          tenantId: h.tenants.acme,
          payload: { paymentId: started.paymentId },
          requestId: 'w',
        },
        silent,
      ),
    );
    expect((await paymentRow(h.tenants.beta, started.paymentId)).status).toBe('PENDING');
    // Beta's own webhook still works.
    expect((await deliver(betaPayment.provider_transaction_id)).statusCode).toBe(200);
    await drain(h.tenants.beta);
    expect((await orderRow(h.tenants.beta, created.id)).status).toBe('PAID');
  });

  it('AC 3: one school’s bad credentials open only its own circuit breaker', async () => {
    // Beta's merchant key is revoked at the provider: its stored credentials no longer authenticate.
    const gateway = h.app.get<PaymentGateway>(PAYMENT_GATEWAY);
    const sealed = gateway.vault.sealAccount(
      h.tenants.beta,
      accounts.beta,
      { merchantId: 'beta-main-0001', apiKey: 'bad-revoked-key', profile: 'NO_REFUND_API' },
      'beta-webhook-0123456789',
    );
    await sql(
      h.tenants.beta,
      `UPDATE payment_account SET credentials_enc = $2, webhook_secret_enc = $3, data_key_enc = $4 WHERE id = $1`,
      [
        accounts.beta,
        Buffer.from(sealed.credentialsEnc),
        Buffer.from(sealed.webhookSecretEnc),
        Buffer.from(sealed.dataKeyEnc),
      ],
    );
    await h.member(BETA, h.tenants.beta, 'b2@example.com', 'Beta Two');
    const learner = await h.signIn(BETA, 'b2@example.com');
    const created = await order(learner, courses.beta, BETA);
    for (let i = 0; i < 6; i += 1) {
      const attempt = await pay(learner, created.id, { method: 'MOBILE_MONEY', msisdn: '0971234567' }, BETA);
      expect(attempt.statusCode).toBe(503);
      expect(attempt.json().code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    }
    // Acme is unaffected.
    const acme = await order(cookies['l9@example.com']!, courses.acme);
    const started = await pay(cookies['l9@example.com']!, acme.id, {
      method: 'MOBILE_MONEY',
      msisdn: '0971234567',
    });
    expect(started.statusCode, started.body).toBe(202);
  });

  it('BR-11: a second success on a paid order is an exception; refunding it leaves the order and access alone', async () => {
    const learner = cookies['l10@example.com']!;
    const created = await order(learner, courses.acme);
    // The learner starts a prompt, then switches number: the first payment is cancelled locally (BR-36)…
    const first = await ok(
      await pay(learner, created.id, { method: 'MOBILE_MONEY', msisdn: '0961010101' }),
      202,
    );
    const second = await ok(
      await pay(learner, created.id, { method: 'MOBILE_MONEY', msisdn: '0961010102' }),
      202,
    );
    expect((await paymentRow(h.tenants.acme, first.paymentId)).status).toBe('CANCELLED');
    // …but both are approved on the phones, and both webhooks arrive.
    for (const paymentId of [first.paymentId, second.paymentId]) {
      const tx = (await paymentRow(h.tenants.acme, paymentId)).provider_transaction_id;
      await fake.decide(tx, 'APPROVE');
      expect((await deliver(tx)).statusCode).toBe(200);
    }
    await drain(h.tenants.acme);
    expect((await orderRow(h.tenants.acme, created.id)).status).toBe('PAID');
    expect((await paymentRow(h.tenants.acme, first.paymentId)).status).toBe('SUCCEEDED'); // late success honoured
    const duplicate = await paymentRow(h.tenants.acme, second.paymentId);
    expect(duplicate).toMatchObject({ status: 'NEEDS_REVIEW', review_reason: 'ALREADY_PAID' });
    expect(await enrollments(h.tenants.acme, courses.acme, 'l10@example.com')).toHaveLength(1);

    const admin = cookies['admin@acme.test']!;
    const detail = await ok(await req('GET', `/api/v1/admin/orders/${created.id}`, { cookie: admin }));
    expect(detail.allowedActions).not.toContain('accept'); // the order is paid: duplicates are refunded
    const refunded = await req('POST', `/api/v1/admin/orders/${created.id}/refunds`, {
      cookie: admin,
      body: { mode: 'PROVIDER', reason: 'Paid twice', paymentId: second.paymentId },
    });
    expect(refunded.statusCode, refunded.body).toBe(201);
    expect((await paymentRow(h.tenants.acme, second.paymentId)).status).toBe('REFUNDED');
    expect((await paymentRow(h.tenants.acme, first.paymentId)).status).toBe('SUCCEEDED');
    expect((await orderRow(h.tenants.acme, created.id)).status).toBe('PAID');
    expect((await enrollments(h.tenants.acme, courses.acme, 'l10@example.com'))[0].status).toBe('ACTIVE');
    const item = (await sql(h.tenants.acme, `SELECT id FROM order_item WHERE order_id = $1`, [created.id]))
      .rows[0].id;
    expect(
      (await sql(h.tenants.acme, `SELECT type FROM ledger_entry WHERE order_item_id = $1`, [item])).rows.map(
        (r: Json) => r.type,
      ),
    ).toEqual(['SALE']);
  });
});
