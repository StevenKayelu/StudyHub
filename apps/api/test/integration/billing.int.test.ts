import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONSOLE,
  consoleSession,
  freshReauth as renewReauth,
  platformSql as platformQuery,
} from '../setup/console-session';
import { type Harness, SCHOOLS, startHarness } from '../setup/school-harness';

const { acme: ACME } = SCHOOLS;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses

/** A hybrid plan: licence, hosting, an SMS add-on, per student, revenue share and setup. */
const HYBRID = {
  currency: 'ZMW',
  billingCycle: 'MONTH',
  trialDays: 0,
  paymentTermsDays: 14,
  allowedPaymentModes: ['TENANT_MERCHANT'],
  components: [
    { type: 'FIXED', key: 'licence', label: 'Platform licence', category: 'LICENCE', amountMinor: 50_000 },
    { type: 'FIXED', key: 'hosting', label: 'Hosting', category: 'HOSTING', amountMinor: 20_000 },
    {
      type: 'FIXED',
      key: 'sms',
      label: 'SMS bundle',
      category: 'MESSAGING',
      amountMinor: 3_000,
      optional: true,
    },
    {
      type: 'PER_STUDENT',
      key: 'students',
      label: 'Active students',
      billableRule: 'ACTIVE_LEARNERS',
      unitAmountMinor: 1_000,
      includedStudents: 1,
    },
    { type: 'REVENUE_SHARE', key: 'share', label: 'Commission on sales', bps: 500, eligibleParts: ['FULL'] },
    { type: 'ONE_TIME', key: 'setup', label: 'Onboarding', category: 'SETUP', amountMinor: 100_000 },
  ],
};

/** SaaS billing foundation (docs/design/saas-billing.md, phase 2), against a real database. */
describe('SaaS billing foundation', () => {
  let h: Harness;
  const staff: Record<string, string> = {};
  let versionId = '';
  let invoiceId = '';

  const ok = async (response: Awaited<ReturnType<Harness['call']>>, status = 200): Promise<Json> => {
    expect(response.statusCode, response.body).toBe(status);
    return response.body === '' ? {} : response.json();
  };
  const consoleCall = (method: 'GET' | 'POST' | 'PATCH', url: string, role: string, body?: unknown) =>
    h.call(method, url, { host: CONSOLE, cookie: staff[role], body });
  const platformSql = (text: string, params: unknown[] = []) => platformQuery(h, text, params);
  /** Inside one school (no platform realm): row-level security applies as for the runtime role. */
  const asSchool = <T>(tenantId: string, query: string, params: unknown[] = []) =>
    h.asTenant(tenantId, () => h.migrator.query(query, params)) as unknown as Promise<{
      rows: T[];
      rowCount: number | null;
    }>;
  const sql = (text: string, params: unknown[] = []) =>
    h.asTenant(h.tenants.acme, () => h.migrator.query(text, params));
  const freshReauth = () => renewReauth(h);

  beforeAll(async () => {
    h = await startHarness();
    for (const role of ['PLATFORM_OWNER', 'PLATFORM_OPERATOR', 'PLATFORM_SUPPORT']) {
      staff[role] = await consoleSession(h, `${role.toLowerCase()}@platform.test`, role);
    }
    // Acme: three learners who joined before August 2026, two enrolled, one instructor and a course.
    for (const n of [1, 2, 3]) await h.member(ACME, h.tenants.acme, `l${n}@example.com`, `Learner ${n}`);
    await sql(`UPDATE tenant_membership SET joined_at = '2026-07-01'`);
    const learners = (
      await sql(
        `SELECT m.id FROM tenant_membership m JOIN user_account a ON a.id = m.user_id WHERE a.email LIKE 'l%@example.com' ORDER BY a.email`,
      )
    ).rows.map((r: Json) => r.id as string);
    const course = (
      await sql(
        `INSERT INTO course (tenant_id, owner_membership_id, slug, title) VALUES ($1, $2, 'paid', 'Paid course') RETURNING id`,
        [h.tenants.acme, learners[0]],
      )
    ).rows[0].id as string;
    for (const learner of learners.slice(0, 2)) {
      await sql(
        `INSERT INTO enrollment (tenant_id, membership_id, course_id, source, started_at) VALUES ($1, $2, $3, 'FREE', '2026-08-01')`,
        [h.tenants.acme, learner, course],
      );
    }
    // August collections: a full purchase (K2 000, K200 refunded) and a deposit (not eligible).
    const account = (
      await sql(
        `INSERT INTO payment_account (tenant_id, provider, label, credentials_enc, webhook_secret_enc, data_key_enc, masked_hint, created_by)
         VALUES ($1, 'fake', 'Main', '\\x00', '\\x00', '\\x00', '••••', $2) RETURNING id`,
        [h.tenants.acme, learners[0]],
      )
    ).rows[0].id as string;
    for (const [part, amount] of [
      ['FULL', 200_000],
      ['DEPOSIT', 50_000],
    ] as const) {
      const order = (
        await sql(
          `INSERT INTO "order" (tenant_id, membership_id, status, currency, total_minor, expires_at, paid_at)
           VALUES ($1, $2, 'PAID', 'ZMW', $3, '2026-08-21', '2026-08-20') RETURNING id`,
          [h.tenants.acme, learners[1], amount],
        )
      ).rows[0].id as string;
      await sql(
        `INSERT INTO order_item (tenant_id, order_id, course_id, instructor_membership_id, title_snapshot, instructor_name_snapshot,
           unit_price_minor, currency, part)
         VALUES ($1, $2, $3, $4, 'Paid course', 'Learner 1', $5, 'ZMW', $6::"OrderItemPart")`,
        [h.tenants.acme, order, course, learners[0], amount, part],
      );
      const payment = (
        await sql(
          `INSERT INTO payment (tenant_id, order_id, payment_account_id, provider, method, amount_minor, currency, status, confirmed_at)
           VALUES ($1, $2, $3, 'fake', 'CARD', $4, 'ZMW', 'SUCCEEDED', '2026-08-20') RETURNING id`,
          [h.tenants.acme, order, account, amount],
        )
      ).rows[0].id as string;
      if (part === 'FULL') {
        await sql(
          `INSERT INTO refund (tenant_id, order_id, payment_id, amount_minor, currency, reason, mode, status, requested_by,
             manual_reference, completed_at)
           VALUES ($1, $2, $3, 20000, 'ZMW', 'Part refund', 'MANUAL', 'SUCCEEDED', $4, 'BANK-1', '2026-08-25')`,
          [h.tenants.acme, order, payment, learners[0]],
        );
      }
    }
  }, 240_000);

  afterAll(async () => {
    await h?.close();
  });

  it('only platform owners (re-authenticated) set prices; support staff can’t see billing', async () => {
    expect((await consoleCall('GET', '/console/billing/plans', 'PLATFORM_SUPPORT')).statusCode).toBe(403);
    expect((await h.call('GET', '/console/billing/plans', { host: CONSOLE })).statusCode).toBe(401);
    const plan = { code: 'school-hybrid', name: 'School hybrid', audience: ['SCHOOL', 'COLLEGE'] };
    await platformSql(`UPDATE platform_session SET reauth_at = now() - interval '1 day'`);
    expect((await consoleCall('POST', '/console/billing/plans', 'PLATFORM_OWNER', plan)).json().code).toBe(
      'REAUTH_REQUIRED',
    );
    await freshReauth();
    expect((await consoleCall('POST', '/console/billing/plans', 'PLATFORM_OPERATOR', plan)).statusCode).toBe(
      403,
    );
    const created = await ok(
      await consoleCall('POST', '/console/billing/plans', 'PLATFORM_OWNER', plan),
      201,
    );
    const bad = await consoleCall('POST', `/console/billing/plans/${created.id}/versions`, 'PLATFORM_OWNER', {
      ...HYBRID,
      components: [...HYBRID.components, HYBRID.components[0]],
    });
    expect(bad.statusCode).toBe(422);
    const version = await ok(
      await consoleCall('POST', `/console/billing/plans/${created.id}/versions`, 'PLATFORM_OWNER', HYBRID),
      201,
    );
    expect(version).toMatchObject({ version: 1, status: 'DRAFT' });
    versionId = version.id;
  });

  it('previews a version, then freezes it once published', async () => {
    const preview = await ok(
      await consoleCall('POST', `/console/billing/versions/${versionId}/preview`, 'PLATFORM_OPERATOR', {
        periodStart: '2026-09-01',
        students: { ACTIVE_LEARNERS: 11 },
        revenue: { grossMinor: 100_000 },
      }),
    );
    // 500 + 200 + 30 (add-on, shown in previews) + 10 × 10 + 5 % of 1 000 + 1 000 setup = K1 880.00
    expect(preview).toMatchObject({ status: 'PREVIEW', totalMinor: '188000', periodEnd: '2026-10-01' });
    await ok(await consoleCall('POST', `/console/billing/versions/${versionId}/publish`, 'PLATFORM_OWNER'));
    const edit = await consoleCall(
      'PATCH',
      `/console/billing/versions/${versionId}`,
      'PLATFORM_OWNER',
      HYBRID,
    );
    expect(edit.json().code).toBe('INVALID_STATE');
    // The database refuses too, whatever the caller.
    await expect(
      platformSql(`UPDATE commercial_plan_version SET components = '[]' WHERE id = $1`, [versionId]),
    ).rejects.toThrow('published plan version can');
  });

  it('contracts: standard ones can’t add components; the active one is unique and its terms freeze', async () => {
    const base = {
      planVersionId: versionId,
      startsOn: '2026-08-15',
      enabledAddons: ['sms'],
      discounts: [
        {
          key: 'launch',
          label: 'Launch offer',
          kind: 'PERCENT',
          value: 1_000,
          appliesTo: ['licence'],
          invoices: 1,
        },
      ],
    };
    const extra = {
      type: 'FIXED',
      key: 'support',
      label: 'Priority support',
      category: 'SERVICE',
      amountMinor: 5_000,
    };
    const refused = await consoleCall(
      'POST',
      `/console/billing/tenants/${h.tenants.acme}/contracts`,
      'PLATFORM_OPERATOR',
      {
        ...base,
        overrides: [extra],
      },
    );
    expect(refused.json().errors[0]).toMatchObject({ field: 'overrides' });
    const contract = await ok(
      await consoleCall(
        'POST',
        `/console/billing/tenants/${h.tenants.acme}/contracts`,
        'PLATFORM_OPERATOR',
        base,
      ),
      201,
    );
    await ok(
      await consoleCall('POST', `/console/billing/contracts/${contract.id}/activate`, 'PLATFORM_OPERATOR'),
      204,
    );
    await expect(
      platformSql(`UPDATE tenant_contract SET billing_anchor_day = 5 WHERE id = $1`, [contract.id]),
    ).rejects.toThrow('active contract');
    const audit = await sql(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at`, [
      contract.id,
    ]);
    expect(audit.rows.map((r: Json) => r.action)).toEqual(['contract.created', 'contract.activated']);
  });

  it('drafts an invoice in arrears from a frozen snapshot, priced to the minor unit', async () => {
    const draft = await ok(
      await consoleCall('POST', `/console/billing/tenants/${h.tenants.acme}/invoices`, 'PLATFORM_OPERATOR', {
        forDate: '2026-08-20',
      }),
      201,
    );
    invoiceId = draft.id;
    expect(draft).toMatchObject({
      status: 'DRAFT',
      number: null,
      periodStart: '2026-08-15',
      periodEnd: '2026-09-01',
    });
    expect(draft.lines.map((l: Json) => [l.kind, l.componentKey, l.amountMinor])).toEqual([
      ['LICENCE', 'licence', '27419'], // 17/31 of K500, half up
      ['HOSTING', 'hosting', '10968'],
      ['SERVICE', 'sms', '1645'],
      ['PER_STUDENT', 'students', '2000'], // 3 learners, 1 included
      ['REVENUE_SHARE', 'share', '9000'], // 5 % of (K2 000 − K200); the deposit isn't eligible
      ['ONE_TIME', 'setup', '100000'],
      ['DISCOUNT', 'launch', '-2742'],
    ]);
    expect(draft).toMatchObject({ subtotalMinor: '151032', discountMinor: '2742', totalMinor: '148290' });
    const snapshot = await platformSql(`SELECT students, revenue FROM usage_snapshot WHERE tenant_ref = $1`, [
      h.tenants.acme,
    ]);
    expect(snapshot.rows[0].students).toEqual({ ACTIVE_LEARNERS: 3, ENROLLED_LEARNERS: 2 });
    expect(snapshot.rows[0].revenue.ZMW.FULL).toMatchObject({
      grossMinor: '200000',
      refundsMinor: '20000',
      transactions: 1,
    });
    // One live invoice per period; a period still running can't be invoiced.
    expect(
      (
        await consoleCall(
          'POST',
          `/console/billing/tenants/${h.tenants.acme}/invoices`,
          'PLATFORM_OPERATOR',
          { forDate: '2026-08-31' },
        )
      ).json().detail,
    ).toBe('This period is already invoiced.');
    const running = new Date().toISOString().slice(0, 10);
    expect(
      (
        await consoleCall(
          'POST',
          `/console/billing/tenants/${h.tenants.acme}/invoices`,
          'PLATFORM_OPERATOR',
          { forDate: running },
        )
      ).json().detail,
    ).toBe('Invoices are drawn up once their period has ended.');
  });

  it('issues once, with a number, a due date and a balanced journal; then the invoice is frozen', async () => {
    await freshReauth();
    const issued = await ok(
      await consoleCall('POST', `/console/billing/invoices/${invoiceId}/issue`, 'PLATFORM_OPERATOR'),
    );
    expect(issued.number).toMatch(/^SAAS-\d{4}-000001$/);
    expect(Date.parse(issued.dueAt) - Date.parse(issued.issuedAt)).toBe(14 * 86_400_000);
    expect(
      (await consoleCall('POST', `/console/billing/invoices/${invoiceId}/issue`, 'PLATFORM_OPERATOR')).json()
        .code,
    ).toBe('INVALID_STATE');
    const balance = await ok(
      await consoleCall(
        'GET',
        `/console/billing/ledger/trial-balance?tenantId=${h.tenants.acme}`,
        'PLATFORM_OPERATOR',
      ),
    );
    const byAccount = Object.fromEntries(balance.accounts.map((a: Json) => [a.account, a.balanceMinor]));
    expect(byAccount).toEqual({
      'receivable.saas': '148290',
      'revenue.commission': '-9000',
      'revenue.discounts': '2742',
      'revenue.hosting': '-10968',
      'revenue.licence': '-27419',
      'revenue.services': '-1645',
      'revenue.setup': '-100000',
      'revenue.usage': '-2000',
    });
    await expect(
      platformSql(`UPDATE saas_invoice SET total_minor = 1 WHERE id = $1`, [invoiceId]),
    ).rejects.toThrow();
    await expect(
      platformSql(
        `INSERT INTO saas_invoice_line (invoice_id, tenant_ref, position, kind, component_key, description, quantity,
           unit_amount_minor, amount_minor, revenue_account)
         VALUES ($1, $2, 99, 'SERVICE', 'x', 'x', 1, 1, 1, 'revenue.services')`,
        [invoiceId, h.tenants.acme],
      ),
    ).rejects.toThrow('draft invoice');
  });

  it('keeps the ledger append-only and balanced at commit', async () => {
    await expect(
      platformSql(`UPDATE platform_ledger_line SET debit_minor = debit_minor + 1`),
    ).rejects.toThrow('append-only');
    await expect(
      platformSql(
        `WITH j AS (INSERT INTO platform_ledger_journal (kind, description, currency, source_type, source_id)
                    VALUES ('TEST', 'unbalanced', 'ZMW', 'test', gen_random_uuid()) RETURNING id)
         INSERT INTO platform_ledger_line (journal_id, account_code, debit_minor, currency)
         SELECT id, 'cash.provider', 100, 'ZMW' FROM j
         UNION ALL SELECT id, 'unreconciled', 0 + 99, 'ZMW' FROM j`,
      ),
    ).rejects.toThrow(/unbalanced|one_side/);
  });

  it('voids with a reversing journal, after which the period can be invoiced again', async () => {
    await freshReauth();
    const voided = await ok(
      await consoleCall('POST', `/console/billing/invoices/${invoiceId}/void`, 'PLATFORM_OPERATOR', {
        reason: 'Wrong student count agreed',
      }),
    );
    expect(voided.status).toBe('VOID');
    const balance = await ok(
      await consoleCall(
        'GET',
        `/console/billing/ledger/trial-balance?tenantId=${h.tenants.acme}`,
        'PLATFORM_OPERATOR',
      ),
    );
    expect(balance.accounts.every((a: Json) => a.balanceMinor === '0')).toBe(true);
    const journals = await platformSql(
      `SELECT kind, reverses_journal_id IS NOT NULL AS reverses FROM platform_ledger_journal WHERE source_id = $1 ORDER BY created_at`,
      [invoiceId],
    );
    expect(journals.rows).toEqual([
      { kind: 'SAAS_INVOICE_ISSUED', reverses: false },
      { kind: 'SAAS_INVOICE_VOIDED', reverses: true },
    ]);
    const again = await ok(
      await consoleCall('POST', `/console/billing/tenants/${h.tenants.acme}/invoices`, 'PLATFORM_OPERATOR', {
        forDate: '2026-08-20',
      }),
      201,
    );
    // Same snapshot (frozen), so the same total; the void left the first invoice untouched.
    expect(again.totalMinor).toBe('148290');
    expect(again.id).not.toBe(invoiceId);
  });

  it('schools read only their own billing records and can’t write any', async () => {
    const count = async (tenantId: string, table: string) =>
      (await asSchool<{ n: number }>(tenantId, `SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
    expect(await count(h.tenants.acme, 'saas_invoice')).toBe(2);
    expect(await count(h.tenants.beta, 'saas_invoice')).toBe(0);
    expect(await count(h.tenants.acme, 'usage_snapshot')).toBe(1);
    expect(await count(h.tenants.acme, 'platform_ledger_line')).toBe(0);
    // Updates see no rows outside the platform realm; inserts are refused outright.
    expect((await asSchool(h.tenants.acme, `UPDATE saas_invoice SET void_reason = 'x'`)).rowCount).toBe(0);
    await expect(
      asSchool(
        h.tenants.acme,
        `INSERT INTO usage_snapshot (tenant_ref, period_start, period_end, students, revenue, rules)
         VALUES ($1, '2026-01-01', '2026-02-01', '{}', '{}', '{}')`,
        [h.tenants.acme],
      ),
    ).rejects.toThrow();
  });
});
