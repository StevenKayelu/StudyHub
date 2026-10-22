import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBillingCycle } from '../../src/modules/billing';
import {
  DEV_IDENTITY_ENCRYPTION_KEY,
  PrismaService,
  runInPlatformTenantTx,
  SecretBox,
} from '../../src/modules/platform';
import { CONSOLE, consoleSession, freshReauth, platformSql } from '../setup/console-session';
import { type Harness, SCHOOLS, startHarness } from '../setup/school-harness';

const { acme: ACME, beta: BETA } = SCHOOLS;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses

const LICENCE = {
  type: 'FIXED',
  key: 'licence',
  label: 'Platform licence',
  category: 'LICENCE',
  amountMinor: 10_000,
};
const SETUP = { type: 'ONE_TIME', key: 'setup', label: 'Onboarding', category: 'SETUP', amountMinor: 50_000 };
const version = (components: unknown[], extra: Json = {}) => ({
  currency: 'ZMW',
  billingCycle: 'MONTH',
  trialDays: 0,
  graceDays: 7,
  paymentTermsDays: 14,
  allowedPaymentModes: ['TENANT_MERCHANT'],
  components,
  ...extra,
});
const at = (iso: string) => new Date(`${iso}T10:00:00Z`);

/** Subscriptions, recurring invoices, dunning and activation (docs/design/saas-billing.md, phase 3). */
describe('SaaS subscriptions', () => {
  let h: Harness;
  let staff = '';
  let owners: { acme: string; beta: string };
  const box = new SecretBox(DEV_IDENTITY_ENCRYPTION_KEY);
  const versions: Record<string, string> = {};

  const ok = async (response: Awaited<ReturnType<Harness['call']>>, status = 200): Promise<Json> => {
    expect(response.statusCode, response.body).toBe(status);
    return response.body === '' ? {} : response.json();
  };
  const consoleCall = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    await freshReauth(h);
    return h.call(method, url, { host: CONSOLE, cookie: staff, body });
  };
  const sql = (text: string, params: unknown[] = []) => platformSql(h, text, params);
  /** The billing cycle as the worker runs it, at a chosen moment. */
  const cycle = (tenantId: string, now: string) =>
    runInPlatformTenantTx(h.app.get(PrismaService), tenantId, (tx) =>
      runBillingCycle(tx, { box }, tenantId, at(now)),
    );
  const subscription = async (tenantId: string) =>
    (await ok(await consoleCall('GET', `/console/billing/tenants/${tenantId}/subscription`))).subscription;
  const invoices = async (tenantId: string) =>
    (await ok(await consoleCall('GET', `/console/billing/tenants/${tenantId}/invoices`))).invoices as Json[];
  const pay = (
    invoice: Json,
    reference: string,
    amountMinor = Number(invoice.totalMinor) - Number(invoice.amountPaidMinor),
  ) =>
    consoleCall('POST', `/console/billing/invoices/${invoice.id}/payments`, {
      amountMinor,
      method: 'BANK_TRANSFER',
      reference,
      receivedOn: '2026-10-01',
    });
  /** Billing emails queued for a school, with their sealed variables opened. */
  const notices = async (tenantId: string) => {
    const { rows } = await h.asTenant(tenantId, () =>
      h.migrator.query(
        `SELECT payload FROM outbox WHERE topic = 'email.send' AND payload->>'template' = 'saas-invoice' ORDER BY id`,
      ),
    );
    return rows.map(
      (row: Json) =>
        JSON.parse(box.openText(row.payload.sealed, `email:${tenantId}:${row.payload.to}`)).status,
    );
  };
  async function contract(tenantId: string, body: Json): Promise<string> {
    const created = await ok(
      await consoleCall('POST', `/console/billing/tenants/${tenantId}/contracts`, body),
      201,
    );
    return created.id as string;
  }

  beforeAll(async () => {
    h = await startHarness();
    staff = await consoleSession(h, 'owner@platform.test', 'PLATFORM_OWNER');
    owners = {
      acme: await h.member(ACME, h.tenants.acme, 'owner@acme.test', 'Olu Owner'),
      beta: await h.member(BETA, h.tenants.beta, 'owner@beta.test', 'Bo Owner'),
    };
    await h.grantRole(h.tenants.acme, 'owner@acme.test', 'TENANT_OWNER');
    await h.grantRole(h.tenants.beta, 'owner@beta.test', 'TENANT_OWNER');
    owners.beta = await h.signIn(BETA, 'owner@beta.test');
    await sql(
      `INSERT INTO plan (code, name) VALUES ('billing-basic', 'Basic features'), ('billing-plus', 'Plus features')`,
    );
    const plan = await ok(
      await consoleCall('POST', '/console/billing/plans', {
        code: 'school',
        name: 'School plan',
        featurePlanCode: 'billing-basic',
      }),
      201,
    );
    const plus = await ok(
      await consoleCall('POST', '/console/billing/plans', {
        code: 'school-plus',
        name: 'School plus',
        featurePlanCode: 'billing-plus',
      }),
      201,
    );
    for (const [key, planId, body] of [
      ['basic', plan.id, version([LICENCE, SETUP])],
      ['plus', plus.id, version([{ ...LICENCE, amountMinor: 20_000 }])],
      ['trial', plan.id, version([LICENCE, SETUP], { trialDays: 10 })],
    ] as const) {
      const created = await ok(
        await consoleCall('POST', `/console/billing/plans/${planId}/versions`, body),
        201,
      );
      await ok(await consoleCall('POST', `/console/billing/versions/${created.id}/publish`));
      versions[key] = created.id;
    }
  }, 240_000);

  afterAll(async () => {
    await h?.close();
  });

  it('starts a subscription on the active contract and applies the plan’s features', async () => {
    const id = await contract(h.tenants.acme, { planVersionId: versions.basic, startsOn: '2026-06-15' });
    expect(
      (await consoleCall('POST', `/console/billing/tenants/${h.tenants.acme}/subscription`)).json().detail,
    ).toBe('Activate a contract for the school first.');
    await ok(await consoleCall('POST', `/console/billing/contracts/${id}/activate`), 204);
    const started = await ok(
      await consoleCall('POST', `/console/billing/tenants/${h.tenants.acme}/subscription`),
      201,
    );
    expect(started.subscription).toMatchObject({
      status: 'ACTIVE',
      billedThrough: '2026-06-15',
      activationPolicy: 'IMMEDIATE',
    });
    const tenant = await sql(`SELECT p.code FROM tenant t JOIN plan p ON p.id = t.plan_id WHERE t.id = $1`, [
      h.tenants.acme,
    ]);
    expect(tenant.rows[0].code).toBe('billing-basic');
    expect(
      (await consoleCall('POST', `/console/billing/tenants/${h.tenants.acme}/subscription`)).json().code,
    ).toBe('INVALID_STATE');
  });

  it('invoices every ended period in arrears, once, and schedules the reminders', async () => {
    expect(await cycle(h.tenants.acme, '2026-08-03')).toEqual({ invoiced: 2 });
    expect(await cycle(h.tenants.acme, '2026-08-03')).toEqual({ invoiced: 0 });
    const issued = await invoices(h.tenants.acme);
    expect(issued.map((i) => [i.periodStart, i.periodEnd, i.status, i.totalMinor])).toEqual([
      ['2026-07-01', '2026-08-01', 'ISSUED', '10000'],
      ['2026-06-15', '2026-07-01', 'ISSUED', '55333'], // 16/30 of K100 + K500 setup on the first invoice
    ]);
    expect((await subscription(h.tenants.acme)).billedThrough).toBe('2026-08-01');
    expect(await notices(h.tenants.acme)).toEqual(['ISSUED', 'ISSUED']);
    const reminders = await h.asTenant(h.tenants.acme, () =>
      h.migrator.query(
        `SELECT payload->>'kind' AS kind FROM outbox WHERE topic = 'billing.notice' ORDER BY id`,
      ),
    );
    expect(reminders.rows.map((r: Json) => r.kind)).toEqual([
      'DUE_SOON',
      'DUE_TODAY',
      'OVERDUE',
      'DUE_SOON',
      'DUE_TODAY',
      'OVERDUE',
    ]);
  });

  it('is past due after the due date and suspends the school only after the grace period', async () => {
    await cycle(h.tenants.acme, '2026-08-16');
    expect((await subscription(h.tenants.acme)).status).toBe('ACTIVE'); // due 17 August
    await cycle(h.tenants.acme, '2026-08-18');
    expect((await subscription(h.tenants.acme)).status).toBe('PAST_DUE');
    await cycle(h.tenants.acme, '2026-08-23');
    expect((await subscription(h.tenants.acme)).status).toBe('PAST_DUE');
    await cycle(h.tenants.acme, '2026-08-25');
    const suspended = await subscription(h.tenants.acme);
    expect(suspended.status).toBe('SUSPENDED');
    const tenant = await sql(`SELECT status, suspended_reason FROM tenant WHERE id = $1`, [h.tenants.acme]);
    expect(tenant.rows[0]).toMatchObject({
      status: 'SUSPENDED',
      suspended_reason: expect.stringMatching(/^Billing: invoice SAAS-/),
    });
    expect((await notices(h.tenants.acme)).at(-1)).toBe('SUSPENDED');
    expect(suspended.events.map((e: Json) => [e.kind, e.from, e.to])).toEqual([
      ['STARTED', null, 'ACTIVE'],
      ['STATUS_CHANGED', 'ACTIVE', 'PAST_DUE'],
      ['STATUS_CHANGED', 'PAST_DUE', 'SUSPENDED'],
    ]);
  });

  it('records manual payments once, never more than owed, and reactivates the school when paid', async () => {
    const [july, june] = await invoices(h.tenants.acme);
    expect((await pay(june!, 'BANK-1', 999_999)).json().errors[0].field).toBe('amountMinor');
    await ok(await pay(june!, 'BANK-1', 30_000), 204);
    expect((await pay(june!, 'BANK-1', 1_000)).json().errors[0].code).toBe('duplicate');
    expect((await subscription(h.tenants.acme)).status).toBe('SUSPENDED'); // still owes
    await expect(
      sql(`UPDATE saas_invoice SET status = 'VOID', voided_at = now(), void_reason = 'x' WHERE id = $1`, [
        june!.id,
      ]),
    ).rejects.toThrow('with payments');
    await ok(await pay((await invoices(h.tenants.acme))[1]!, 'BANK-2'), 204);
    await ok(await pay(july!, 'BANK-3'), 204);
    const back = await subscription(h.tenants.acme);
    expect(back.status).toBe('ACTIVE');
    expect(
      (await sql(`SELECT status, suspended_reason FROM tenant WHERE id = $1`, [h.tenants.acme])).rows[0],
    ).toEqual({
      status: 'ACTIVE',
      suspended_reason: null,
    });
    expect((await invoices(h.tenants.acme)).map((i) => i.status)).toEqual(['PAID', 'PAID']);
    expect((await notices(h.tenants.acme)).slice(-2)).toEqual(['PAID', 'REACTIVATED']);
    const ledger = await ok(
      await consoleCall('GET', `/console/billing/ledger/trial-balance?tenantId=${h.tenants.acme}`),
    );
    const balances = Object.fromEntries(ledger.accounts.map((a: Json) => [a.account, a.balanceMinor]));
    expect(balances['receivable.saas']).toBe('0');
    expect(balances['cash.bank']).toBe('65333');
    await expect(sql(`UPDATE saas_payment SET amount_minor = 1`)).rejects.toThrow('append-only');
  });

  it('a suspension made by staff is never lifted by billing', async () => {
    await sql(`UPDATE tenant SET status = 'SUSPENDED', suspended_reason = 'Abuse report' WHERE id = $1`, [
      h.tenants.acme,
    ]);
    await cycle(h.tenants.acme, '2026-08-26');
    expect((await sql(`SELECT status FROM tenant WHERE id = $1`, [h.tenants.acme])).rows[0].status).toBe(
      'SUSPENDED',
    );
    await sql(`UPDATE tenant SET status = 'ACTIVE', suspended_reason = NULL WHERE id = $1`, [h.tenants.acme]);
  });

  it('changes plan mid-period: each contract bills its share, and the new features apply at once', async () => {
    const plus = await contract(h.tenants.acme, { planVersionId: versions.plus, startsOn: '2026-08-16' });
    await ok(
      await consoleCall('POST', `/console/billing/tenants/${h.tenants.acme}/subscription/change-plan`, {
        contractId: plus,
      }),
    );
    const tenant = await sql(`SELECT p.code FROM tenant t JOIN plan p ON p.id = t.plan_id WHERE t.id = $1`, [
      h.tenants.acme,
    ]);
    expect(tenant.rows[0].code).toBe('billing-plus');
    expect(await cycle(h.tenants.acme, '2026-09-02')).toEqual({ invoiced: 2 });
    const [newPlan, oldPlan] = await invoices(h.tenants.acme);
    expect([oldPlan!.periodStart, oldPlan!.periodEnd, oldPlan!.totalMinor]).toEqual([
      '2026-08-01',
      '2026-08-16',
      '4839',
    ]); // 15/31 of K100
    expect([newPlan!.periodStart, newPlan!.periodEnd, newPlan!.totalMinor]).toEqual([
      '2026-08-16',
      '2026-09-01',
      '10323',
    ]); // 16/31 of K200
    // A plan change can't reach back into invoiced periods.
    const late = await contract(h.tenants.acme, { planVersionId: versions.basic, startsOn: '2026-08-20' });
    expect(
      (
        await consoleCall('POST', `/console/billing/tenants/${h.tenants.acme}/subscription/change-plan`, {
          contractId: late,
        })
      ).json().detail,
    ).toBe('A plan change can’t start in a period already invoiced.');
  });

  it('cancels at period end: the period is billed, then billing stops; data stays', async () => {
    await ok(
      await consoleCall('POST', `/console/billing/tenants/${h.tenants.acme}/subscription/cancel`, {
        atPeriodEnd: true,
        reason: 'Moving to another provider',
      }),
    );
    expect(await cycle(h.tenants.acme, '2026-10-02')).toEqual({ invoiced: 1 }); // September, then stop
    const cancelled = await subscription(h.tenants.acme);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', billedThrough: '2026-10-01' });
    expect(await cycle(h.tenants.acme, '2027-01-02')).toEqual({ invoiced: 0 });
    expect((await sql(`SELECT status FROM tenant WHERE id = $1`, [h.tenants.acme])).rows[0].status).toBe(
      'ACTIVE',
    );
    await expect(
      sql(`UPDATE tenant_subscription SET status = 'ACTIVE', cancelled_at = NULL WHERE tenant_ref = $1`, [
        h.tenants.acme,
      ]),
    ).rejects.toThrow("can't move from CANCELLED");
  });

  it('a setup-fee contract gates go-live until paid; trials then end into the first invoice', async () => {
    await sql(`UPDATE tenant SET status = 'PROVISIONING' WHERE id = $1`, [h.tenants.beta]);
    const id = await contract(h.tenants.beta, {
      planVersionId: versions.trial,
      startsOn: '2026-09-01',
      activationPolicy: 'AFTER_SETUP_PAYMENT',
    });
    await ok(await consoleCall('POST', `/console/billing/contracts/${id}/activate`), 204);
    const started = await ok(
      await consoleCall('POST', `/console/billing/tenants/${h.tenants.beta}/subscription`),
      201,
    );
    expect(started.subscription).toMatchObject({
      status: 'TRIALING',
      trialEndsOn: '2026-09-11',
      setupPaidAt: null,
    });
    const [setup] = await invoices(h.tenants.beta);
    expect(setup).toMatchObject({ kind: 'SETUP', status: 'ISSUED', totalMinor: '50000' });
    expect(setup!.dueAt).toBe(setup!.issuedAt); // due at once
    const goLive = () =>
      h.call('POST', '/api/v1/admin/onboarding/go-live', { host: BETA, cookie: owners.beta });
    expect((await goLive()).json().code).toBe('SETUP_PAYMENT_REQUIRED');
    await ok(await pay(setup!, 'BANK-SETUP'), 204);
    expect((await subscription(h.tenants.beta)).setupPaidAt).not.toBeNull();
    expect((await goLive()).json().code).toBe('ONBOARDING_INCOMPLETE'); // the gate is lifted
    expect(await notices(h.tenants.beta)).toEqual(['ISSUED', 'SETUP_PAID']);

    await cycle(h.tenants.beta, '2026-10-02');
    const after = await subscription(h.tenants.beta);
    expect(after.status).toBe('ACTIVE');
    expect(after.events.map((e: Json) => e.kind)).toContain('TRIAL_ENDED');
    const [september] = await invoices(h.tenants.beta);
    // 20/30 of K100 after the 10-day trial; the setup charge isn't billed again.
    expect(september).toMatchObject({ kind: 'RECURRING', totalMinor: '6667' });
    expect(september!.lines.map((l: Json) => l.kind)).toEqual(['LICENCE']);
  });

  it('schools read their own subscription records only', async () => {
    const read = (tenantId: string, table: string) =>
      h
        .asTenant(tenantId, () => h.migrator.query(`SELECT count(*)::int AS n FROM ${table}`))
        .then((r) => r.rows[0].n);
    expect(await read(h.tenants.beta, 'tenant_subscription')).toBe(1);
    expect(await read(h.tenants.beta, 'saas_payment')).toBe(1);
    expect(await read(h.tenants.beta, 'subscription_event')).toBeGreaterThan(0);
    expect(await read(h.tenants.acme, 'saas_payment')).toBe(3);
  });
});
