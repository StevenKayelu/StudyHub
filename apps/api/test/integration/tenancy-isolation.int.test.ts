import { randomBytes, randomUUID } from 'node:crypto';

import type { Client, QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionTenant } from '../../src/modules/tenancy';
import { startTestDatabase, type TestDatabase } from '../setup/postgres-container';
import {
  findPlatformPolicyViolations,
  findRoleViolations,
  findTenancyViolations,
  PLATFORM_VISIBLE_TABLES,
  tenantOwnedTables,
} from '../setup/tenancy-checks';

const INSUFFICIENT_PRIVILEGE = '42501'; // also raised for "new row violates row-level security policy"
const FOREIGN_KEY_VIOLATION = '23503';

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** Runs `fn` in one transaction with a transaction-local tenant context (as the app does). */
async function asTenant<T>(client: Client, tenantId: string, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Outcome of an operation against another tenant's rows: affected rows, or denied outright. */
async function outcome(run: () => Promise<QueryResult>): Promise<'denied' | number> {
  try {
    const result = await run();
    return result.rows[0]?.count !== undefined ? Number(result.rows[0].count) : (result.rowCount ?? 0);
  } catch (error) {
    if ((error as { code?: string }).code === INSUFFICIENT_PRIVILEGE) return 'denied';
    throw error;
  }
}

/** One person (global account, D3) who is a member of both schools in the fixtures. */
let personId = '';
/** The fixture membership of each school, so dependent fixtures (and forgeries) can reference it. */
const membershipOf: Record<string, string> = {};
const fixtureHash = () => randomBytes(32);
/** Ids of fixture rows per table and school, for fixtures (and forgeries) that reference them. */
const idOf: Record<string, Record<string, string>> = {};
const remember = (table: string, tenantId: string, result: QueryResult<{ id: string }>) => {
  (idOf[table] ??= {})[tenantId] ??= result.rows[0]!.id;
  return result;
};
const ref = (table: string, tenantId: string) => idOf[table]?.[tenantId] ?? randomUUID();

/** How to create one row of each tenant-owned table. A new tenant table MUST be added here (T-ISO-05). */
const FIXTURES: Readonly<
  Record<string, { granted: boolean; insert: (c: Client, tenantId: string) => Promise<unknown> }>
> = {
  audit_log: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO audit_log (tenant_id, action, entity_type, entity_id) VALUES ($1, 'iso.fixture', 'fixture', $2)`,
        [tenantId, `marker-${tenantId}`],
      ),
  },
  outbox: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(`INSERT INTO outbox (tenant_id, topic, payload) VALUES ($1, 'iso.fixture', $2::jsonb)`, [
        tenantId,
        JSON.stringify({ marker: tenantId }),
      ]),
  },
  // Insertion order matters: memberships first, then rows that reference them.
  tenant_membership: {
    granted: true,
    insert: async (c, tenantId) => {
      const result = await c.query<{ id: string }>(
        `INSERT INTO tenant_membership (tenant_id, user_id, status) VALUES ($1, $2, 'ACTIVE')
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = EXCLUDED.status RETURNING id`,
        [tenantId, personId],
      );
      membershipOf[tenantId] ??= result.rows[0]!.id;
      return result;
    },
  },
  membership_role: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(`INSERT INTO membership_role (tenant_id, membership_id, role) VALUES ($1, $2, 'LEARNER')`, [
        tenantId,
        membershipOf[tenantId] ?? randomUUID(),
      ]),
  },
  session: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO session (tenant_id, user_id, membership_id, token_hash, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '1 day')`,
        [tenantId, personId, membershipOf[tenantId] ?? randomUUID(), fixtureHash()],
      ),
  },
  invitation: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO invitation (tenant_id, email, role, token_hash, expires_at)
         VALUES ($1, $2, 'INSTRUCTOR', $3, now() + interval '1 day')`,
        [tenantId, `invitee-${randomUUID().slice(0, 8)}@example.com`, fixtureHash()],
      ),
  },
  category: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'category',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO category (tenant_id, slug, name) VALUES ($1, $2, 'Fixture') RETURNING id`,
          [tenantId, `fixture-${randomUUID().slice(0, 8)}`],
        ),
      ),
  },
  subject: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'subject',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO subject (tenant_id, category_id, slug, name) VALUES ($1, $2, $3, 'Fixture') RETURNING id`,
          [tenantId, ref('category', tenantId), `fixture-${randomUUID().slice(0, 8)}`],
        ),
      ),
  },
  asset: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'asset',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO asset (tenant_id, owner_membership_id, kind, purpose, original_name, mime, size_bytes, storage_key)
         VALUES ($1, $2, 'DOCUMENT', 'LESSON_FILE', 'fixture.pdf', 'application/pdf', 10, $3) RETURNING id`,
          [tenantId, membershipOf[tenantId] ?? randomUUID(), `t/${tenantId}/fixture/${randomUUID()}`],
        ),
      ),
  },
  tenant_usage: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO tenant_usage (tenant_id, storage_bytes) VALUES ($1, 1)
         ON CONFLICT (tenant_id) DO UPDATE SET storage_bytes = tenant_usage.storage_bytes`,
        [tenantId],
      ),
  },
  instructor_profile: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO instructor_profile (membership_id, tenant_id, slug, display_name) VALUES ($1, $2, $3, 'Fixture')
         ON CONFLICT (membership_id) DO NOTHING`,
        [membershipOf[tenantId] ?? randomUUID(), tenantId, `fixture-${randomUUID().slice(0, 8)}`],
      ),
  },
  course: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'course',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO course (tenant_id, owner_membership_id, slug, title) VALUES ($1, $2, $3, 'Fixture course') RETURNING id`,
          [tenantId, membershipOf[tenantId] ?? randomUUID(), `fixture-${randomUUID().slice(0, 8)}`],
        ),
      ),
  },
  course_submission: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO course_submission (tenant_id, course_id, submitted_by, checklist_snapshot) VALUES ($1, $2, $3, '[]')`,
        [tenantId, ref('course', tenantId), personId],
      ),
  },
  section: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'section',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO section (tenant_id, course_id, title, position)
         VALUES ($1, $2, 'Fixture', (SELECT coalesce(max(position) + 1, 0) FROM section WHERE course_id = $2)) RETURNING id`,
          [tenantId, ref('course', tenantId)],
        ),
      ),
  },
  lesson: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'lesson',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO lesson (tenant_id, course_id, section_id, title, type, position)
         VALUES ($1, $2, $3, 'Fixture', 'TEXT', (SELECT coalesce(max(position) + 1, 0) FROM lesson WHERE section_id = $3)) RETURNING id`,
          [tenantId, ref('course', tenantId), ref('section', tenantId)],
        ),
      ),
  },
  lesson_attachment: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO lesson_attachment (tenant_id, lesson_id, asset_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [tenantId, ref('lesson', tenantId), ref('asset', tenantId)],
      ),
  },
  enrollment: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'enrollment',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO enrollment (tenant_id, membership_id, course_id, source, status)
         VALUES ($1, $2, $3, 'FREE', 'EXPIRED') RETURNING id`,
          [tenantId, membershipOf[tenantId] ?? randomUUID(), ref('course', tenantId)],
        ),
      ),
  },
  lesson_progress: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO lesson_progress (tenant_id, enrollment_id, lesson_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [tenantId, ref('enrollment', tenantId), ref('lesson', tenantId)],
      ),
  },
  question: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'question',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO question (tenant_id, course_id, created_by, type, stem_json)
         VALUES ($1, $2, $3, 'SINGLE_CHOICE', '{"type":"doc"}') RETURNING id`,
          [tenantId, ref('course', tenantId), membershipOf[tenantId] ?? randomUUID()],
        ),
      ),
  },
  question_option: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO question_option (tenant_id, question_id, position, content_json, is_correct)
         VALUES ($1, $2, (SELECT coalesce(max(position) + 1, 0) FROM question_option WHERE question_id = $2), '"A"', true)`,
        [tenantId, ref('question', tenantId)],
      ),
  },
  quiz: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'quiz',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO quiz (tenant_id, course_id, title) VALUES ($1, $2, 'Fixture quiz') RETURNING id`,
          [tenantId, ref('course', tenantId)],
        ),
      ),
  },
  quiz_item: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO quiz_item (tenant_id, quiz_id, question_id, position)
         VALUES ($1, $2, $3, (SELECT coalesce(max(position) + 1, 0) FROM quiz_item WHERE quiz_id = $2))
         ON CONFLICT (tenant_id, quiz_id, question_id) DO NOTHING`,
        [tenantId, ref('quiz', tenantId), ref('question', tenantId)],
      ),
  },
  quiz_draw_rule: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(`INSERT INTO quiz_draw_rule (tenant_id, quiz_id, count) VALUES ($1, $2, 1)`, [
        tenantId,
        ref('quiz', tenantId),
      ]),
  },
  attempt: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'attempt',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO attempt (tenant_id, membership_id, course_id, mode, status)
         VALUES ($1, $2, $3, 'PRACTICE', 'GRADED') RETURNING id`,
          [tenantId, membershipOf[tenantId] ?? randomUUID(), ref('course', tenantId)],
        ),
      ),
  },
  attempt_item: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'attempt_item',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO attempt_item (tenant_id, attempt_id, position, question_id, question_snapshot, points)
         VALUES ($1, $2, (SELECT coalesce(max(position) + 1, 0) FROM attempt_item WHERE attempt_id = $2), $3, '{}', 1)
         RETURNING id`,
          [tenantId, ref('attempt', tenantId), ref('question', tenantId)],
        ),
      ),
  },
  attempt_answer: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO attempt_answer (tenant_id, attempt_item_id, response) VALUES ($1, $2, '{"text":"x"}')
         ON CONFLICT DO NOTHING`,
        [tenantId, ref('attempt_item', tenantId)],
      ),
  },
  // M8 commerce, in dependency order.
  payment_account: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'payment_account',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO payment_account (tenant_id, provider, label, credentials_enc, webhook_secret_enc, data_key_enc,
             masked_hint, created_by)
           VALUES ($1, 'fake', 'Fixture account', decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'),
                   '••••', $2) RETURNING id`,
          [tenantId, membershipOf[tenantId] ?? randomUUID()],
        ),
      ),
  },
  order: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'order',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO "order" (tenant_id, membership_id, currency, total_minor, expires_at)
           VALUES ($1, $2, 'ZMW', 25000, now() + interval '30 minutes') RETURNING id`,
          [tenantId, membershipOf[tenantId] ?? randomUUID()],
        ),
      ),
  },
  order_item: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'order_item',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO order_item (tenant_id, order_id, course_id, instructor_membership_id, title_snapshot,
             instructor_name_snapshot, unit_price_minor, currency)
           VALUES ($1, $2, $3, $4, 'Fixture course', 'Fixture tutor', 25000, 'ZMW') RETURNING id`,
          [tenantId, ref('order', tenantId), ref('course', tenantId), membershipOf[tenantId] ?? randomUUID()],
        ),
      ),
  },
  payment: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'payment',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO payment (tenant_id, order_id, payment_account_id, provider, method, amount_minor, currency)
           VALUES ($1, $2, $3, 'fake', 'CARD', 25000, 'ZMW') RETURNING id`,
          [tenantId, ref('order', tenantId), ref('payment_account', tenantId)],
        ),
      ),
  },
  payment_event: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO payment_event (tenant_id, payment_account_id, provider_event_id, payment_id, type, payload)
         VALUES ($1, $2, $3, $4, 'payment.updated', '{}')`,
        [tenantId, ref('payment_account', tenantId), `ev_${randomUUID()}`, ref('payment', tenantId)],
      ),
  },
  refund: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'refund',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO refund (tenant_id, order_id, payment_id, amount_minor, currency, reason, mode, status,
             manual_reference, requested_by)
           VALUES ($1, $2, $3, 25000, 'ZMW', 'Fixture refund', 'MANUAL', 'FAILED', 'REF-1', $4) RETURNING id`,
          [
            tenantId,
            ref('order', tenantId),
            ref('payment', tenantId),
            membershipOf[tenantId] ?? randomUUID(),
          ],
        ),
      ),
  },
  receipt_sequence: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO receipt_sequence (tenant_id, year, last_value) VALUES ($1, 2001, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE SET last_value = receipt_sequence.last_value + 1`,
        [tenantId],
      ),
  },
  receipt: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(`INSERT INTO receipt (tenant_id, order_id, number, year, seq) VALUES ($1, $2, $3, 2001, $4)`, [
        tenantId,
        ref('order', tenantId),
        `ISO-2001-${randomUUID().slice(0, 8)}`,
        Math.floor(Math.random() * 1e9),
      ]),
  },
  idempotency_key: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO idempotency_key (tenant_id, membership_id, key, route, request_hash)
         VALUES ($1, $2, $3, 'POST /orders', 'hash')`,
        [tenantId, membershipOf[tenantId] ?? randomUUID(), `iso-${randomUUID()}`],
      ),
  },
  payout_method: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO payout_method (tenant_id, membership_id, type, details_enc, display_hint)
         VALUES ($1, $2, 'BANK', decode('00', 'hex'), 'Bank ••••0000')`,
        [tenantId, membershipOf[tenantId] ?? randomUUID()],
      ),
  },
  payout: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO payout (tenant_id, instructor_membership_id, amount_minor, currency, external_reference,
           paid_at, recorded_by)
         VALUES ($1, $2, 100, 'ZMW', 'PAY-1', now(), $2)`,
        [tenantId, membershipOf[tenantId] ?? randomUUID()],
      ),
  },
  ledger_entry: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO ledger_entry (tenant_id, instructor_membership_id, type, gross_minor, net_minor, currency,
           available_at, note)
         VALUES ($1, $2, 'ADJUSTMENT', 100, 100, 'ZMW', now(), 'Fixture adjustment')`,
        [tenantId, membershipOf[tenantId] ?? randomUUID()],
      ),
  },
  ledger_check: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO ledger_check (tenant_id, ok, sales_expected_minor, sales_recorded_minor,
           reversals_expected_minor, reversals_recorded_minor)
         VALUES ($1, true, 0, 0, 0, 0)`,
        [tenantId],
      ),
  },
  // M9 (migration 0009): school administration and the console
  support_access_grant: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'support_access_grant',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO support_access_grant (tenant_id, platform_user_id, staff_display_name, reason)
           VALUES ($1, $2, 'Fixture Staff', 'Fixture support request for isolation tests') RETURNING id`,
          [tenantId, randomUUID()],
        ),
      ),
  },
  support_session: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO support_session (tenant_id, grant_id, platform_user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
        [tenantId, ref('support_access_grant', tenantId), randomUUID(), fixtureHash()],
      ),
  },
  tenant_usage_daily: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO tenant_usage_daily (tenant_id, date, active_learners) VALUES ($1, '2001-01-01', 1)
         ON CONFLICT DO NOTHING`,
        [tenantId],
      ),
  },
  data_export: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(`INSERT INTO data_export (tenant_id, type, requested_by) VALUES ($1, 'ORDERS', $2)`, [
        tenantId,
        membershipOf[tenantId] ?? randomUUID(),
      ]),
  },
  domain_change_request: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO domain_change_request (tenant_id, current_slug, requested_slug, reason, status, requested_by)
         VALUES ($1, 'iso', $2, 'Fixture request', 'REJECTED', $3)`,
        [tenantId, `iso-${randomUUID().slice(0, 8)}`, membershipOf[tenantId] ?? randomUUID()],
      ),
  },
  settlement_report: {
    granted: true,
    insert: async (c, tenantId) =>
      remember(
        'settlement_report',
        tenantId,
        await c.query<{ id: string }>(
          `INSERT INTO settlement_report (tenant_id, payment_account_id, period_start, period_end, source, created_by)
           VALUES ($1, $2, '2001-01-01', '2001-01-31', 'CSV', $3) RETURNING id`,
          [tenantId, ref('payment_account', tenantId), membershipOf[tenantId] ?? randomUUID()],
        ),
      ),
  },
  settlement_item: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO settlement_item (tenant_id, report_id, reference, kind, currency)
         VALUES ($1, $2, $3, 'MISSING_LOCAL', 'ZMW')`,
        [tenantId, ref('settlement_report', tenantId), `ref-${randomUUID()}`],
      ),
  },
  platform_statement: {
    granted: false, // written only in the console realm (platform_statement_guard)
    insert: (c, tenantId) =>
      c.query(`INSERT INTO platform_statement (tenant_id, period) VALUES ($1, '2001-01')`, [tenantId]),
  },
  notification: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO notification (tenant_id, membership_id, kind, title) VALUES ($1, $2, 'iso', 'Fixture')`,
        [tenantId, membershipOf[tenantId] ?? randomUUID()],
      ),
  },
  notification_preference: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO notification_preference (tenant_id, membership_id, category, email_enabled)
         VALUES ($1, $2, 'earnings', false) ON CONFLICT DO NOTHING`,
        [tenantId, membershipOf[tenantId] ?? randomUUID()],
      ),
  },
  tenant_archive: {
    granted: false, // no runtime grants at all: written only by purge_tenant()
    insert: (c, tenantId) =>
      c.query(`INSERT INTO tenant_archive (tenant_id, source_table, row_data) VALUES ($1, 'iso', '{}')`, [
        tenantId,
      ]),
  },
  tenant_feature: {
    granted: true, // schools switch features from M9 (F40); only the console sets overrides (trigger)
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO tenant_feature (tenant_id, feature_key, enabled_by_tenant) VALUES ($1, 'practiceMode', false)
         ON CONFLICT DO NOTHING`,
        [tenantId],
      ),
  },
  tenant_branding: {
    granted: true, // the branding editor publishes it (F39, M9)
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1, 'Forged School') ON CONFLICT DO NOTHING`,
        [tenantId],
      ),
  },
  tenant_branding_version: {
    granted: true,
    insert: (c, tenantId) =>
      c.query(`INSERT INTO tenant_branding_version (tenant_id, version, snapshot) VALUES ($1, 99, '{}')`, [
        tenantId,
      ]),
  },
  tenant_setting: {
    granted: true, // administrators edit the payments group from M8 (S-AD09)
    insert: (c, tenantId) =>
      c.query(
        `INSERT INTO tenant_setting (tenant_id, key, value) VALUES ($1, 'isoFixture', '1')
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [tenantId],
      ),
  },
  tenant_domain: {
    granted: false, // a school reads its own hosts; only the console adds them (tenant_platform_guard, M9)
    insert: (c, tenantId) =>
      c.query(`INSERT INTO tenant_domain (tenant_id, hostname) VALUES ($1, $2)`, [
        tenantId,
        `iso-${randomUUID().slice(0, 8)}.localhost`,
      ]),
  },
};

describe('tenant isolation in PostgreSQL (T-ISO-01..09, 15, 16)', () => {
  let database: TestDatabase;
  let migrator: Client;
  let app: Client;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    database = await startTestDatabase({ migrate: true });
    migrator = await database.connect(database.migratorUrl);
    app = await database.connect(database.appUrl);

    const first = await provisionTenant(migrator, {
      slug: 'acme',
      name: 'Acme Academy',
      kind: 'SCHOOL',
      hostname: 'acme.localhost',
      status: 'ACTIVE',
    });
    const second = await provisionTenant(migrator, {
      slug: 'beta',
      name: 'Beta College',
      kind: 'COLLEGE',
      hostname: 'beta.localhost',
      status: 'ACTIVE',
    });
    if (first.outcome !== 'created' || second.outcome !== 'created') throw new Error('provisioning failed');
    tenantA = first.tenantId;
    tenantB = second.tenantId;

    // The fixture person: created as themselves (user_account's WITH CHECK is id = app.user_id).
    personId = randomUUID();
    await migrator.query('BEGIN');
    await migrator.query(`SELECT set_config('app.user_id', $1, true)`, [personId]);
    await migrator.query(
      `INSERT INTO user_account (id, email, display_name) VALUES ($1, $2, 'Fixture Person')`,
      [personId, `person-${personId.slice(0, 8)}@example.com`],
    );
    await migrator.query('COMMIT');

    for (const tenantId of [tenantA, tenantB]) {
      for (const fixture of Object.values(FIXTURES)) {
        if (fixture.granted) await asTenant(app, tenantId, () => fixture.insert(app, tenantId));
      }
    }
  });

  afterAll(async () => {
    await app?.end();
    await migrator?.end();
    await database?.stop();
  });

  it('T-ISO-03: every table follows the structural tenancy rules', async () => {
    expect(await findTenancyViolations(migrator)).toEqual([]);
  });

  it('T-ISO-21: console-realm policies only on the ADR-0020 allowlist, with no personal columns', async () => {
    expect(await findPlatformPolicyViolations(migrator)).toEqual([]);
  });

  it('T-ISO-21: the console realm sees school metadata, and nothing of any other school table', async () => {
    const asConsole = async (sql: string) => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.realm', 'platform', true)`);
        return await outcome(() => app.query(sql));
      } finally {
        await app.query('ROLLBACK');
      }
    };
    expect(await asConsole('SELECT count(*) FROM tenant')).toBeGreaterThanOrEqual(2);
    expect(await asConsole('SELECT count(*) FROM tenant_usage_daily')).toBeGreaterThanOrEqual(2);
    for (const table of await tenantOwnedTables(migrator)) {
      if (PLATFORM_VISIBLE_TABLES.has(table)) continue;
      expect(await asConsole(`SELECT count(*) FROM "${table}"`), `${table} in the console realm`).toSatisfy(
        (value: unknown) => value === 0 || value === 'denied',
      );
    }
    // School members and accounts stay invisible too.
    expect(await asConsole('SELECT count(*) FROM user_account')).toBe(0);
  });

  it('T-ISO-21: a school cannot create schools, add hosts, change its plan or forge statements', async () => {
    expect(
      await sqlState(
        asTenant(app, tenantB, () =>
          app.query(`UPDATE tenant SET slug = 'beta-new' WHERE id = $1`, [tenantB]),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(asTenant(app, tenantB, () => FIXTURES.tenant_domain!.insert(app, tenantB)))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await sqlState(asTenant(app, tenantB, () => FIXTURES.platform_statement!.insert(app, tenantB))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlState(
        asTenant(app, tenantB, () =>
          app.query(
            `INSERT INTO tenant_feature (tenant_id, feature_key, platform_override) VALUES ($1, 'whiteLabel', 'GRANT')`,
            [tenantB],
          ),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('T-ISO-03 (meta): the check catches a tenant table without RLS', async () => {
    await migrator.query('CREATE TABLE iso_unprotected (id int PRIMARY KEY, tenant_id uuid NOT NULL)');
    try {
      const violations = await findTenancyViolations(migrator);
      expect(violations).toEqual(
        expect.arrayContaining([
          'iso_unprotected: row-level security is not enabled',
          'iso_unprotected: row-level security is not forced',
        ]),
      );
    } finally {
      await migrator.query('DROP TABLE iso_unprotected');
    }
  });

  it('T-ISO-01/02: no login role can bypass RLS; the app role owns nothing and has DML only', async () => {
    expect(await findRoleViolations(migrator)).toEqual([]);
  });

  it('T-ISO-04: with no tenant context every tenant table is empty and writes fail', async () => {
    for (const table of [...(await tenantOwnedTables(migrator)), 'tenant']) {
      const result = await outcome(() => app.query(`SELECT count(*) FROM "${table}"`));
      expect([0, 'denied'], `${table} without context`).toContain(result);
    }
    expect(await sqlState(FIXTURES.audit_log!.insert(app, tenantA))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('T-ISO-05: every tenant table has a fixture (new tables must join this matrix)', async () => {
    const tables = await tenantOwnedTables(migrator);
    expect(tables.filter((table) => !(table in FIXTURES))).toEqual([]);
  });

  it('T-ISO-05: as tenant B, tenant A rows cannot be read, changed, deleted or forged', async () => {
    const isolated = (value: unknown) => value === 0 || value === 'denied';
    for (const table of await tenantOwnedTables(migrator)) {
      const fixture = FIXTURES[table]!;
      // Each operation in its own transaction: a denied statement aborts the transaction it runs in.
      const asB = (sql: string) => outcome(() => asTenant(app, tenantB, () => app.query(sql, [tenantA])));
      expect(await asB(`SELECT count(*) FROM "${table}" WHERE tenant_id = $1`), `${table} read`).toSatisfy(
        isolated,
      );
      expect(
        await asB(`UPDATE "${table}" SET tenant_id = tenant_id WHERE tenant_id = $1`),
        `${table} update`,
      ).toSatisfy(isolated);
      expect(await asB(`DELETE FROM "${table}" WHERE tenant_id = $1`), `${table} delete`).toSatisfy(isolated);
      // Forging: inserting a row that belongs to A while acting as B.
      expect(
        await sqlState(asTenant(app, tenantB, () => fixture.insert(app, tenantA))),
        `${table} forged insert`,
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('T-ISO-05 (controls): tenant A sees its own rows, so the matrix is not vacuous', async () => {
    for (const [table, fixture] of Object.entries(FIXTURES)) {
      if (!fixture.granted) continue;
      const count = await asTenant(app, tenantA, () =>
        outcome(() => app.query(`SELECT count(*) FROM "${table}"`)),
      );
      expect(count, table).toBeGreaterThan(0);
    }
  });

  it('T-ISO-05: FORCE RLS applies to the table owner (migrator) too', async () => {
    for (const table of await tenantOwnedTables(migrator)) {
      const count = await asTenant(migrator, tenantB, () =>
        outcome(() => migrator.query(`SELECT count(*) FROM "${table}" WHERE tenant_id = $1`, [tenantA])),
      );
      expect(count, table).toBe(0);
    }
  });

  it('the tenant row itself is visible only inside its own context', async () => {
    const asB = await asTenant(app, tenantB, () => app.query(`SELECT id FROM tenant`));
    expect(asB.rows).toEqual([{ id: tenantB }]);
    const none = await app.query(`SELECT id FROM tenant`);
    expect(none.rows).toEqual([]);
  });

  it('a school sees only its own hosts; host resolution goes through resolve_tenant() (M9)', async () => {
    expect((await app.query('SELECT * FROM tenant_domain')).rows).toEqual([]);
    const own = await asTenant(app, tenantB, () => app.query('SELECT hostname FROM tenant_domain'));
    expect(own.rows).toEqual([{ hostname: 'beta.localhost' }]);
    const known = await app.query(
      `SELECT tenant_id, status::text AS status, primary_host, is_redirect FROM resolve_tenant('ACME.localhost')`,
    );
    expect(known.rows).toEqual([
      { tenant_id: tenantA, status: 'ACTIVE', primary_host: 'acme.localhost', is_redirect: false },
    ]);
    const unknown = await app.query(`SELECT * FROM resolve_tenant('nope.localhost')`);
    expect(unknown.rows).toEqual([]);
  });

  it('claim_due_outbox() returns only (id, tenant_id) and never row content', async () => {
    const claimed = await app.query(`SELECT * FROM claim_due_outbox(10)`);
    expect(claimed.fields.map((field) => field.name)).toEqual(['id', 'tenant_id']);
    expect(new Set(claimed.rows.map((row: { tenant_id: string }) => row.tenant_id))).toEqual(
      new Set([tenantA, tenantB]),
    );
  });

  describe('T-ISO-06/07: composite tenant keys', () => {
    beforeAll(async () => {
      await migrator.query(`
        CREATE TABLE iso_parent (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), slug text NOT NULL,
                                 UNIQUE (tenant_id, id), UNIQUE (tenant_id, slug));
        CREATE TABLE iso_child (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, parent_id uuid NOT NULL,
                                FOREIGN KEY (tenant_id, parent_id) REFERENCES iso_parent (tenant_id, id));
        CREATE TABLE iso_child_naive (id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
                                      parent_id uuid NOT NULL REFERENCES iso_parent (id));
        SELECT tenancy_apply_isolation('iso_parent');
        SELECT tenancy_apply_isolation('iso_child');
        SELECT tenancy_apply_isolation('iso_child_naive');
        GRANT SELECT, INSERT ON iso_parent, iso_child, iso_child_naive TO studyhub_app;`);
    });

    afterAll(async () => {
      await migrator.query('DROP TABLE iso_child_naive, iso_child, iso_parent');
    });

    it('rejects a child in tenant B that references tenant A parent (composite FK)', async () => {
      const parentA = randomUUID();
      await asTenant(app, tenantA, () =>
        app.query(`INSERT INTO iso_parent (id, tenant_id, slug) VALUES ($1, $2, 'biology')`, [
          parentA,
          tenantA,
        ]),
      );
      const state = await sqlState(
        asTenant(app, tenantB, () =>
          app.query(`INSERT INTO iso_child (id, tenant_id, parent_id) VALUES ($1, $2, $3)`, [
            randomUUID(),
            tenantB,
            parentA,
          ]),
        ),
      );
      expect(state).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('documents why: a single-column FK is checked without RLS and would accept it', async () => {
      const parentA = randomUUID();
      await asTenant(app, tenantA, () =>
        app.query(`INSERT INTO iso_parent (id, tenant_id, slug) VALUES ($1, $2, 'chemistry')`, [
          parentA,
          tenantA,
        ]),
      );
      await expect(
        asTenant(app, tenantB, () =>
          app.query(`INSERT INTO iso_child_naive (id, tenant_id, parent_id) VALUES ($1, $2, $3)`, [
            randomUUID(),
            tenantB,
            parentA,
          ]),
        ),
      ).resolves.toBeDefined();
    });

    it('allows the same natural key in two tenants (tenant-scoped unique keys)', async () => {
      await asTenant(app, tenantA, () =>
        app.query(`INSERT INTO iso_parent (id, tenant_id, slug) VALUES ($1, $2, 'physics')`, [
          randomUUID(),
          tenantA,
        ]),
      );
      await expect(
        asTenant(app, tenantB, () =>
          app.query(`INSERT INTO iso_parent (id, tenant_id, slug) VALUES ($1, $2, 'physics')`, [
            randomUUID(),
            tenantB,
          ]),
        ),
      ).resolves.toBeDefined();
    });
  });

  it('T-ISO-08 (meta): a view without security_invoker is flagged', async () => {
    await migrator.query('CREATE VIEW iso_view AS SELECT id, tenant_id FROM audit_log');
    try {
      expect(await findTenancyViolations(migrator)).toContain('iso_view: view is not security_invoker');
    } finally {
      await migrator.query('DROP VIEW iso_view');
    }
  });

  it('T-ISO-09 (meta): an uninventoried SECURITY DEFINER function is flagged', async () => {
    await migrator.query(
      `CREATE FUNCTION iso_rogue() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM audit_log'`,
    );
    try {
      const violations = await findTenancyViolations(migrator);
      expect(violations).toEqual(
        expect.arrayContaining([
          'iso_rogue: SECURITY DEFINER function not on the inventory',
          'iso_rogue: search_path is not fixed',
        ]),
      );
    } finally {
      await migrator.query('DROP FUNCTION iso_rogue()');
    }
  });

  it('T-ISO-15: a pooled connection never carries tenant context past its transaction', async () => {
    const inside = await asTenant(app, tenantA, () => app.query('SELECT count(*)::int AS n FROM audit_log'));
    expect(inside.rows[0].n).toBeGreaterThan(0);
    const after = await app.query(
      `SELECT count(*)::int AS n, coalesce(current_setting('app.tenant_id', true), '') AS ctx FROM audit_log`,
    );
    expect(after.rows[0]).toEqual({ n: 0, ctx: '' });
  });

  it('T-ISO-16: planner statistics of tenant tables are hidden from the app role', async () => {
    await migrator.query(
      `INSERT INTO platform_setting (key, value) VALUES ('iso.stats', '1') ON CONFLICT DO NOTHING`,
    );
    await migrator.query('ANALYZE audit_log; ANALYZE outbox; ANALYZE platform_setting');
    const tenantStats = await app.query(
      `SELECT count(*)::int AS n FROM pg_stats WHERE schemaname = 'public' AND tablename IN ('audit_log', 'outbox', 'tenant', 'tenant_domain')`,
    );
    expect(tenantStats.rows[0].n).toBe(0);
    const control = await app.query(
      `SELECT count(*)::int AS n FROM pg_stats WHERE schemaname = 'public' AND tablename = 'platform_setting'`,
    );
    expect(control.rows[0].n).toBeGreaterThan(0);
  });
});
