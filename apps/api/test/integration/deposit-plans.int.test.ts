import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../src/modules/audit';
import {
  BALANCE_REMINDER_JOB,
  type CommerceDeps,
  createBalanceReminderHandler,
  createPaymentEventHandler,
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

const { acme: ACME } = SCHOOLS;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses

const PRICE = 25_000;
const DEPOSIT = 10_000;
const BALANCE = PRICE - DEPOSIT;
const PLAN = { depositMinor: DEPOSIT, lessonPct: 30, balanceDueDays: 30 };
const RULES = { enabled: true, minDepositPct: 20, maxBalanceDays: 90 };
const DAY_MS = 86_400_000;

/** Deposit payment plans end to end (docs/design/payment-plans.md), against the fake provider. */
describe('deposit payment plans', () => {
  let h: Harness;
  let deps: CommerceDeps;
  const silent = createLogger({ level: 'silent' });
  const cookies: Record<string, string> = {};
  let courseId = '';
  const lessons: string[] = [];
  const quizzes = { open: '', locked: '', course: '' };
  let ip = 1;

  const req = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
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
        ...options.headers,
      },
      ...(options.body !== undefined && { payload: JSON.stringify(options.body) }),
    });
  const ok = async (response: Awaited<ReturnType<typeof req>>, status = 200): Promise<Json> => {
    expect(response.statusCode, response.body).toBe(status);
    return response.json();
  };
  const sql = (text: string, params: unknown[] = []) =>
    h.asTenant(h.tenants.acme, () => h.migrator.query(text, params));
  const enrollment = async (email: string): Promise<Json> =>
    (
      await sql(
        `SELECT e.* FROM enrollment e JOIN tenant_membership m ON m.id = e.membership_id
           JOIN user_account a ON a.id = m.user_id WHERE e.course_id = $1 AND a.email = $2
          ORDER BY e.started_at DESC`,
        [courseId, email],
      )
    ).rows[0];

  const handlers: Record<string, (envelope: JobEnvelope, logger: typeof silent) => Promise<unknown>> = {};
  /** Runs the due payment events through the worker handler (reminders are run explicitly). */
  async function drain(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      const { rows } = await sql(
        `SELECT id, topic, payload FROM outbox
          WHERE dispatched_at IS NULL AND topic = $1 AND available_at <= now() ORDER BY id`,
        [PAYMENT_EVENT_JOB],
      );
      if (rows.length === 0) return;
      for (const row of rows) {
        await sql(`UPDATE outbox SET dispatched_at = now() WHERE id = $1`, [row.id]);
        await runWithContext({ requestId: `test_${row.id}`, tenantId: h.tenants.acme }, () =>
          handlers[row.topic]!(
            { type: row.topic, tenantId: h.tenants.acme, payload: row.payload, requestId: 'test' },
            silent,
          ),
        );
      }
    }
  }

  /** Orders a part of the course and pays it on the simulated phone; returns the order. */
  async function buy(email: string, part: 'FULL' | 'DEPOSIT' | 'BALANCE', msisdn: string): Promise<Json> {
    const cookie = cookies[email]!;
    const created = await ok(await req('POST', '/api/v1/orders', { cookie, body: { courseId, part } }), 201);
    const started = await ok(
      await req('POST', `/api/v1/orders/${created.id}/payments`, {
        cookie,
        body: { method: 'MOBILE_MONEY', msisdn },
      }),
      202,
    );
    await ok(await req('POST', `/api/v1/dev/fake-pay/phone/${started.paymentId}/approve`, { cookie }));
    await drain();
    return ok(await req('GET', `/api/v1/orders/${created.id}`, { cookie }));
  }

  const studio = (body: Json) =>
    req('GET', `/api/v1/studio/courses/${courseId}`, { cookie: cookies['tutor@acme.test']! }).then(
      async (current) =>
        req('PATCH', `/api/v1/studio/courses/${courseId}`, {
          cookie: cookies['tutor@acme.test']!,
          body: { version: current.json().version, ...body },
        }),
    );
  const setRules = (rules: Json) =>
    req('PATCH', '/api/v1/admin/settings', {
      cookie: cookies['owner@acme.test']!,
      body: { depositPlans: rules, reason: 'Deposit plans for exam courses' },
    });

  beforeAll(async () => {
    h = await startHarness();
    deps = {
      prisma: h.app.get(PrismaService),
      gateway: h.app.get<PaymentGateway>(PAYMENT_GATEWAY),
      box: new SecretBox(DEV_IDENTITY_ENCRYPTION_KEY),
      schoolUrlTemplate: 'http://{host}:3000',
      audit: new AuditService(),
    };
    handlers[PAYMENT_EVENT_JOB] = createPaymentEventHandler(deps);

    for (const [email, role, name] of [
      ['owner@acme.test', 'TENANT_OWNER', 'Olu Owner'],
      ['tutor@acme.test', 'INSTRUCTOR', 'Tiko Phiri'],
    ] as const) {
      await h.member(ACME, h.tenants.acme, email, name);
      await h.grantRole(h.tenants.acme, email, role);
      cookies[email] = await h.signIn(ACME, email);
    }
    for (const n of [1, 2]) {
      cookies[`l${n}@example.com`] = await h.member(
        ACME,
        h.tenants.acme,
        `l${n}@example.com`,
        `Learner ${n}`,
      );
    }
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
        `INSERT INTO course (tenant_id, owner_membership_id, slug, title, status, first_published_at, published_at,
           price_minor, currency)
         VALUES ($1, $2, 'exam-prep', 'Exam preparation', 'PUBLISHED', now(), now(), $3, 'ZMW') RETURNING id`,
        [h.tenants.acme, tutor, PRICE],
      )
    ).rows[0].id as string;
    // Ten lessons in two sections; lesson 6 is a free preview.
    for (const section of [1, 2]) {
      const sectionId = (
        await sql(
          `INSERT INTO section (tenant_id, course_id, title, position) VALUES ($1, $2, $3, $4) RETURNING id`,
          [h.tenants.acme, courseId, `Part ${section}`, section],
        )
      ).rows[0].id as string;
      for (let position = 1; position <= 5; position += 1) {
        const number = (section - 1) * 5 + position;
        lessons.push(
          (
            await sql(
              `INSERT INTO lesson (tenant_id, course_id, section_id, title, type, position, is_preview, content_json)
               VALUES ($1, $2, $3, $4, 'TEXT', $5, $6, '{"type":"doc","content":[]}') RETURNING id`,
              [h.tenants.acme, courseId, sectionId, `Lesson ${number}`, position, number === 6],
            )
          ).rows[0].id as string,
        );
      }
    }
    // Quizzes on an open lesson (2), on a locked lesson (8) and one attached to no lesson.
    for (const key of ['open', 'locked', 'course'] as const) {
      quizzes[key] = (
        await sql(
          `INSERT INTO quiz (tenant_id, course_id, title, status) VALUES ($1, $2, $3, 'READY') RETURNING id`,
          [h.tenants.acme, courseId, `Quiz ${key}`],
        )
      ).rows[0].id as string;
    }
    await sql(`UPDATE lesson SET type = 'QUIZ', quiz_id = $2 WHERE id = $1`, [lessons[1], quizzes.open]);
    await sql(`UPDATE lesson SET type = 'QUIZ', quiz_id = $2 WHERE id = $1`, [lessons[7], quizzes.locked]);
    await sql(
      `INSERT INTO tenant_feature (tenant_id, feature_key, enabled_by_tenant) VALUES ($1, 'instructorRevenueShare', true)`,
      [h.tenants.acme],
    );
    await h.setSetting(h.tenants.acme, 'refundWindowDays', 0);
    const account = await ok(
      await req('POST', '/api/v1/admin/payment-accounts', {
        cookie: cookies['owner@acme.test']!,
        body: {
          provider: 'fake',
          label: 'Main account',
          credentials: {
            merchantId: 'acme-merchant-0001',
            apiKey: 'acme-api-key-SECRET',
            webhookSecret: 'acme-webhook-SECRET-0123456789',
            profile: 'FULL',
          },
        },
      }),
      201,
    );
    for (const step of ['test', 'activate']) {
      await ok(
        await req('POST', `/api/v1/admin/payment-accounts/${account.id}/${step}`, {
          cookie: cookies['owner@acme.test']!,
        }),
      );
    }
    // With revenue share, the tutor needs a payout method before the course is offered (BR-04).
    await ok(
      await req('POST', '/api/v1/me/payout-methods', {
        cookie: cookies['tutor@acme.test']!,
        body: { type: 'MOBILE_MONEY', msisdn: '0961112233', accountName: 'Tiko Phiri' },
      }),
      201,
    );
  }, 240_000);

  afterAll(async () => {
    await h?.close();
  });

  it('tutors set a plan only within the school rules, and the course page offers it', async () => {
    // Off by default: no plan can be saved and none is offered.
    const off = await studio({ depositPlan: PLAN });
    expect(off.statusCode).toBe(422);
    expect(off.json().errors[0]).toMatchObject({ field: 'depositPlan', code: 'DEPOSIT_PLANS_OFF' });
    // Only administrators set the rules.
    expect(
      (
        await req('PATCH', '/api/v1/admin/settings', {
          cookie: cookies['tutor@acme.test']!,
          body: { depositPlans: RULES, reason: 'Not mine to change' },
        })
      ).statusCode,
    ).toBe(403);
    await ok(await setRules(RULES));

    const low = await studio({ depositPlan: { ...PLAN, depositMinor: 4000 } });
    expect(low.json().errors[0]).toMatchObject({
      field: 'depositPlan.depositMinor',
      code: 'DEPOSIT_TOO_LOW',
    });
    const long = await studio({ depositPlan: { ...PLAN, balanceDueDays: 120 } });
    expect(long.json().errors[0]).toMatchObject({ field: 'depositPlan.balanceDueDays', code: 'TOO_LONG' });
    const high = await studio({ depositPlan: { ...PLAN, depositMinor: PRICE } });
    expect(high.json().errors[0]).toMatchObject({ code: 'DEPOSIT_TOO_HIGH' });

    const saved = await ok(await studio({ depositPlan: PLAN }));
    expect(saved).toMatchObject({ depositPlan: PLAN, depositRules: RULES });
    // The price can't drop to or below the deposit while the plan exists.
    const cheaper = await studio({ priceMinor: DEPOSIT });
    expect(cheaper.json().errors[0]).toMatchObject({ field: 'priceMinor', code: 'BELOW_DEPOSIT' });

    const landing = await ok(
      await req('GET', '/api/v1/courses/exam-prep', { cookie: cookies['l1@example.com']! }),
    );
    expect(landing.depositPlan).toEqual({ ...PLAN, balanceMinor: BALANCE });
    expect(landing.viewer).toMatchObject({ purchasable: true, depositAvailable: true, balance: null });
  });

  it('the deposit opens the first 30 % of lessons (and previews); the rest is locked until the balance', async () => {
    const before = Date.now();
    const paid = await buy('l1@example.com', 'DEPOSIT', '0971234567');
    expect(paid).toMatchObject({
      status: 'PAID',
      total: { amountMinor: DEPOSIT },
      items: [{ part: 'DEPOSIT', unitPrice: { amountMinor: DEPOSIT } }],
    });
    const row = await enrollment('l1@example.com');
    expect(row).toMatchObject({
      status: 'ACTIVE',
      access_limit_pct: 30,
      plan_lesson_pct: 30,
      balance_minor: String(BALANCE),
      balance_order_item_id: null,
    });
    const due = new Date(row.balance_due_at).getTime();
    expect(due).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(due).toBeLessThan(Date.now() + 30 * DAY_MS + 1000);

    const learner = cookies['l1@example.com']!;
    const player = await ok(await req('GET', `/api/v1/learn/courses/${courseId}`, { cookie: learner }));
    const locked = player.sections.flatMap((s: Json) => s.lessons).map((l: Json) => l.locked);
    // 30 % of 10 = 3 open; lesson 6 is a preview, so it stays open too.
    expect(locked).toEqual([false, false, false, true, true, false, true, true, true, true]);
    expect(player.enrollment.balance).toMatchObject({
      amount: { amountMinor: BALANCE, currency: 'ZMW' },
      overdue: false,
      lessonPct: 30,
    });
    await ok(await req('GET', `/api/v1/learn/lessons/${lessons[2]}`, { cookie: learner }));
    const refused = await req('GET', `/api/v1/learn/lessons/${lessons[3]}`, { cookie: learner });
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({
      code: 'BALANCE_REQUIRED',
      courseId,
      balanceMinor: BALANCE,
      lessonPct: 30,
    });
    // Progress can't be saved on a locked lesson either.
    expect(
      (
        await req('PUT', `/api/v1/learn/lessons/${lessons[3]}/progress`, {
          cookie: learner,
          body: { status: 'COMPLETED' },
        })
      ).statusCode,
    ).toBe(402);

    // Quizzes: only those on an open lesson (PROPOSED 2).
    await ok(await req('GET', `/api/v1/learn/quizzes/${quizzes.open}`, { cookie: learner }));
    for (const quiz of [quizzes.locked, quizzes.course]) {
      expect((await req('GET', `/api/v1/learn/quizzes/${quiz}`, { cookie: learner })).statusCode).toBe(402);
      expect(
        (await req('POST', `/api/v1/learn/quizzes/${quiz}/attempts`, { cookie: learner })).statusCode,
      ).toBe(402);
    }

    // The deposit is its own sale and receipt; the instructor earns on what was paid.
    const sale = (await sql(`SELECT gross_minor FROM ledger_entry WHERE type = 'SALE'`)).rows;
    expect(sale).toEqual([{ gross_minor: String(DEPOSIT) }]);
    const receipt = await ok(await req('GET', `/api/v1/me/orders/${paid.id}/receipt`, { cookie: learner }));
    expect(receipt.items).toEqual([expect.objectContaining({ part: 'DEPOSIT' })]);
    const reminders = (await sql(`SELECT available_at FROM outbox WHERE topic = $1`, [BALANCE_REMINDER_JOB]))
      .rows;
    expect(reminders).toHaveLength(2);

    // Already enrolled: no second deposit or full purchase.
    for (const part of ['FULL', 'DEPOSIT']) {
      const again = await req('POST', '/api/v1/orders', { cookie: learner, body: { courseId, part } });
      expect(again.json().code).toBe('ALREADY_ENROLLED');
    }
    const landing = await ok(await req('GET', '/api/v1/courses/exam-prep', { cookie: learner }));
    expect(landing.viewer.balance).toMatchObject({ amount: { amountMinor: BALANCE }, lessonPct: 30 });
  });

  it('reminds the learner of the balance, and only while it is unpaid', async () => {
    const reminder = createBalanceReminderHandler(deps);
    const { enrollmentId } = (
      await sql(`SELECT payload FROM outbox WHERE topic = $1 LIMIT 1`, [BALANCE_REMINDER_JOB])
    ).rows[0].payload;
    const run = () =>
      runWithContext({ requestId: 'reminder', tenantId: h.tenants.acme }, () =>
        reminder({
          type: BALANCE_REMINDER_JOB,
          tenantId: h.tenants.acme,
          payload: { enrollmentId },
          requestId: 'r',
        }),
      );
    expect(await run()).toEqual({ sent: true });
    const emails = (
      await sql(`SELECT payload->>'to' AS to FROM outbox WHERE payload->>'template' = 'balance-reminder'`)
    ).rows;
    expect(emails).toEqual([{ to: 'l1@example.com' }]);
    // A learner who doesn't owe anything is never reminded.
    expect(
      await runWithContext({ requestId: 'reminder', tenantId: h.tenants.acme }, () =>
        reminder({
          type: BALANCE_REMINDER_JOB,
          tenantId: h.tenants.acme,
          payload: { enrollmentId: courseId },
          requestId: 'r',
        }),
      ),
    ).toEqual({ sent: false });
  });

  it('the balance opens everything, and can still be paid after the deadline', async () => {
    // Past the deadline: the deposit's lessons stay open and the balance is overdue but payable.
    await sql(`UPDATE enrollment SET balance_due_at = now() - interval '1 day' WHERE course_id = $1`, [
      courseId,
    ]);
    const learner = cookies['l1@example.com']!;
    const overdue = await ok(await req('GET', `/api/v1/learn/courses/${courseId}`, { cookie: learner }));
    expect(overdue.enrollment.balance.overdue).toBe(true);
    await ok(await req('GET', `/api/v1/learn/lessons/${lessons[0]}`, { cookie: learner }));

    const paid = await buy('l1@example.com', 'BALANCE', '0971234567');
    expect(paid).toMatchObject({
      status: 'PAID',
      total: { amountMinor: BALANCE },
      items: [{ part: 'BALANCE' }],
    });
    const row = await enrollment('l1@example.com');
    expect(row.access_limit_pct).toBeNull();
    expect(row.balance_order_item_id).not.toBeNull();
    const player = await ok(await req('GET', `/api/v1/learn/courses/${courseId}`, { cookie: learner }));
    expect(player.sections.flatMap((s: Json) => s.lessons).every((l: Json) => !l.locked)).toBe(true);
    expect(player.enrollment.balance).toBeNull();
    await ok(await req('GET', `/api/v1/learn/lessons/${lessons[9]}`, { cookie: learner }));

    const sales = (await sql(`SELECT gross_minor FROM ledger_entry WHERE type = 'SALE' ORDER BY created_at`))
      .rows;
    expect(sales.map((s: Json) => Number(s.gross_minor))).toEqual([DEPOSIT, BALANCE]);
    const nothing = await req('POST', '/api/v1/orders', {
      cookie: learner,
      body: { courseId, part: 'BALANCE' },
    });
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json().code).toBe('INVALID_STATE');
  });

  it('refunds: the deposit only after the balance; a refunded balance locks the rest again', async () => {
    const owner = cookies['owner@acme.test']!;
    const orders = (
      await sql(
        `SELECT o.id, i.part FROM "order" o JOIN order_item i ON i.order_id = o.id WHERE o.status = 'PAID'`,
      )
    ).rows as { id: string; part: string }[];
    const deposit = orders.find((o) => o.part === 'DEPOSIT')!.id;
    const balance = orders.find((o) => o.part === 'BALANCE')!.id;
    const refund = (orderId: string) =>
      req('POST', `/api/v1/admin/orders/${orderId}/refunds`, {
        cookie: owner,
        body: { mode: 'MANUAL', reason: 'Learner asked', reference: `MM-${orderId.slice(0, 8)}` },
      });

    const first = await refund(deposit);
    expect(first.statusCode).toBe(409);
    expect(first.json().detail).toContain('Refund the balance order first');

    await ok(await refund(balance), 201);
    const row = await enrollment('l1@example.com');
    expect(row).toMatchObject({ status: 'ACTIVE', access_limit_pct: 30, balance_order_item_id: null });
    const learner = cookies['l1@example.com']!;
    expect((await req('GET', `/api/v1/learn/lessons/${lessons[9]}`, { cookie: learner })).statusCode).toBe(
      402,
    );
    await ok(await req('GET', `/api/v1/learn/lessons/${lessons[0]}`, { cookie: learner }));
    const email = (
      await sql(
        `SELECT payload FROM outbox WHERE payload->>'template' = 'refund-learner' ORDER BY id DESC LIMIT 1`,
      )
    ).rows;
    expect(email).toHaveLength(1);

    await ok(await refund(deposit), 201);
    expect(await enrollment('l1@example.com')).toMatchObject({ status: 'REVOKED' });
    expect((await req('GET', `/api/v1/learn/lessons/${lessons[0]}`, { cookie: learner })).statusCode).toBe(
      403,
    );
  });

  it('a later plan change keeps what earlier learners agreed; switching plans off stops new deposits', async () => {
    await ok(await studio({ depositPlan: { ...PLAN, depositMinor: 12_500, lessonPct: 50 } }));
    await buy('l2@example.com', 'DEPOSIT', '0961112233');
    expect(await enrollment('l2@example.com')).toMatchObject({
      access_limit_pct: 50,
      balance_minor: String(PRICE - 12_500),
    });
    await ok(await studio({ depositPlan: PLAN }));
    expect(await enrollment('l2@example.com')).toMatchObject({ access_limit_pct: 50 });

    await ok(await setRules({ ...RULES, enabled: false }));
    const landing = await ok(
      await req('GET', '/api/v1/courses/exam-prep', { cookie: cookies['l1@example.com']! }),
    );
    expect(landing.depositPlan).toBeNull();
    expect(landing.viewer.depositAvailable).toBe(false);
    const refused = await req('POST', '/api/v1/orders', {
      cookie: cookies['l1@example.com']!,
      body: { courseId, part: 'DEPOSIT' },
    });
    expect(refused.json().code).toBe('COURSE_NOT_PURCHASABLE');
    // A learner who already paid a deposit can still pay the balance.
    const balance = await req('POST', '/api/v1/orders', {
      cookie: cookies['l2@example.com']!,
      body: { courseId, part: 'BALANCE' },
    });
    expect(balance.statusCode, balance.body).toBe(201);
    expect(balance.json().total.amountMinor).toBe(PRICE - 12_500);
  });
});
