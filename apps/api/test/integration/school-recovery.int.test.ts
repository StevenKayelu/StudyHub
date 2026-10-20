import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import type { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applySchoolContentRecovery, fullExport, planSchoolContentRecovery } from '../../src/modules/admin';
import {
  STORAGE_LOCATIONS,
  type StorageLocations,
  PrismaService,
  runInTenantTx,
  runWithContext,
} from '../../src/modules/platform';
import { type Harness, startHarness } from '../setup/school-harness';
import { asTenant, ref, seedFixtures } from '../setup/tenant-fixtures';

describe('reviewed single-school content recovery (M10)', () => {
  let h: Harness;
  let prisma: PrismaService;
  let observer: Client;
  let archive: Map<string, Buffer>;
  let ownerId: string;
  let supportId: string;
  let otherOwnerId: string;
  let course: string;
  let section: string;
  let lesson: string;
  const approval = {
    reason: 'Recover reviewed damaged teaching content',
    ownerReviewReference: 'disposable-owner-review-001',
  };
  const asStaff = <T>(fn: () => T, staff = ownerId) =>
    runWithContext({ requestId: `recovery-${randomUUID()}`, platformUserId: staff }, fn);
  const plan = (entries = archive, tenant = h.tenants.acme) =>
    asStaff(() => planSchoolContentRecovery(prisma, tenant, entries));
  const apply = (digest: string, entries = archive) =>
    asStaff(() => applySchoolContentRecovery(prisma, h.tenants.acme, entries, { digest, ...approval }));

  beforeAll(async () => {
    h = await startHarness({ objectStore: true });
    prisma = h.app.get(PrismaService);
    observer = await h.database.connect(h.database.superuserUrl);
    const app = await h.database.connect(h.database.appUrl);
    try {
      await seedFixtures(h.migrator, app, [h.tenants.acme, h.tenants.beta]);
    } finally {
      await app.end();
    }
    ownerId = randomUUID();
    supportId = randomUUID();
    otherOwnerId = randomUUID();
    await observer.query(
      `INSERT INTO platform_user (id,email,display_name,role) VALUES ($1,'recovery-owner@platform.test','Recovery owner','PLATFORM_OWNER'),($2,'recovery-support@platform.test','Recovery support','PLATFORM_SUPPORT')`,
      [ownerId, supportId],
    );
    await observer.query(
      `INSERT INTO platform_user (id,email,display_name,role) VALUES ($1,'other-recovery-owner@platform.test','Other recovery owner','PLATFORM_OWNER')`,
      [otherOwnerId],
    );
    course = ref('course', h.tenants.acme);
    section = ref('section', h.tenants.acme);
    lesson = ref('lesson', h.tenants.acme);
    const exported = await runWithContext({ requestId: 'scratch-export', tenantId: h.tenants.acme }, () =>
      runInTenantTx(prisma, (tx) => fullExport(tx, h.app.get<StorageLocations>(STORAGE_LOCATIONS))),
    );
    archive = new Map(exported.entries.map(({ name, data }) => [name, data]));
    // Shared identity is newer than the scratch export and must never be rolled back by recovery.
    await observer.query(
      `UPDATE user_account SET display_name='Current shared identity' WHERE id=(SELECT user_id FROM tenant_membership WHERE id=$1)`,
      [ref('tenant_membership', h.tenants.acme)],
    );
  }, 300_000);
  beforeEach(async () => {
    await asTenant(h.migrator, h.tenants.acme, async () => {
      await h.migrator.query(`UPDATE course SET title='Damaged course' WHERE id=$1`, [course]);
      await h.migrator.query(`UPDATE section SET title='Damaged section' WHERE id=$1`, [section]);
      await h.migrator.query(`UPDATE lesson SET title='Damaged lesson' WHERE id=$1`, [lesson]);
    });
  });
  afterAll(async () => {
    await observer?.end();
    await h?.close();
  });

  async function snapshot(): Promise<Record<string, string>> {
    const tables = await observer.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );
    const result: Record<string, string> = {};
    for (const { tablename } of tables.rows) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablename)) throw new Error('Unexpected table');
      result[tablename] = (
        await observer.query<{ hash: string }>(
          `SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS hash FROM "${tablename}" t`,
        )
      ).rows[0]!.hash;
      result[`foreign:${tablename}`] = (
        await observer.query<{ hash: string }>(
          `SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS hash FROM "${tablename}" t WHERE coalesce(to_jsonb(t)->>'tenant_id',to_jsonb(t)->>'tenant_ref')=$1`,
          [h.tenants.beta],
        )
      ).rows[0]!.hash;
    }
    return result;
  }
  function changedEntry(
    table: string,
    edit: (rows: Array<Record<string, unknown>>) => void,
  ): Map<string, Buffer> {
    const copy = new Map(archive);
    const name = `data/${table}.json`;
    const rows = JSON.parse(copy.get(name)!.toString()) as Array<Record<string, unknown>>;
    edit(rows);
    copy.set(name, Buffer.from(JSON.stringify(rows)));
    return copy;
  }

  it('plans without writing, restores only reviewed content, preserves every other table and school, and appends both audits', async () => {
    const before = await snapshot();
    const review = await plan();
    expect(review.scope).toBe('existing-course-content-v1');
    expect(review.blockers).toEqual([]);
    expect(review.changes.map((change) => change.table)).toEqual(['course', 'section', 'lesson']);
    expect(await snapshot()).toEqual(before);
    const betaBefore = await observer.query(
      `SELECT md5(string_agg(t::text,'|' ORDER BY t::text)) AS hash FROM course t WHERE tenant_id=$1`,
      [h.tenants.beta],
    );
    const sourceCourse = JSON.parse(archive.get('data/course.json')!.toString())[0] as Record<
      string,
      unknown
    >;
    const versionBefore = (await observer.query('SELECT version FROM course WHERE id=$1', [course])).rows[0]
      .version as number;
    const start = performance.now();
    expect(await apply(review.reviewDigest)).toEqual({ changed: 3 });
    const after = await snapshot();
    for (const [table, hash] of Object.entries(before)) {
      if (!['course', 'section', 'lesson', 'audit_log', 'platform_audit_log'].includes(table))
        expect(after[table], table).toBe(hash);
    }
    expect((await observer.query('SELECT title,version FROM course WHERE id=$1', [course])).rows[0]).toEqual({
      title: sourceCourse.title,
      version: versionBefore + 1,
    });
    expect(
      (
        await observer.query(
          `SELECT md5(string_agg(t::text,'|' ORDER BY t::text)) AS hash FROM course t WHERE tenant_id=$1`,
          [h.tenants.beta],
        )
      ).rows,
    ).toEqual(betaBefore.rows);
    const audit = await observer.query(
      `SELECT actor_id,after FROM audit_log WHERE tenant_id=$1 AND action='school.recovered'`,
      [h.tenants.acme],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBe(ownerId);
    expect(audit.rows[0].after).toMatchObject({
      changed: 3,
      reviewDigest: review.reviewDigest,
      ownerReviewReference: approval.ownerReviewReference,
    });
    expect(
      (
        await observer.query(
          `SELECT id FROM platform_audit_log WHERE tenant_ref=$1 AND action='school.recovered'`,
          [h.tenants.acme],
        )
      ).rowCount,
    ).toBe(1);
    const stable = await snapshot();
    const noop = await plan();
    expect(await apply(noop.reviewDigest)).toEqual({ changed: 0 });
    expect(await snapshot()).toEqual(stable);
    mkdirSync('test-results/recovery', { recursive: true });
    writeFileSync(
      'test-results/recovery/single-school.json',
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          scope: review.scope,
          changed: 3,
          validatedMs: performance.now() - start,
          preservedTables: Object.keys(before).filter((name) => !name.startsWith('foreign:')).length - 5,
          sharedIdentitiesUnchanged: true,
        },
        null,
        2,
      ),
    );
  });

  it('repairs invalid live rich content and regenerates derived description text', async () => {
    await observer.query(`UPDATE course SET description_text='Damaged search text' WHERE id=$1`, [course]);
    await observer.query(`UPDATE lesson SET content_json='{"type":"script"}'::jsonb WHERE id=$1`, [lesson]);
    const review = await plan();
    await apply(review.reviewDigest);
    expect(
      (await observer.query('SELECT description_text FROM course WHERE id=$1', [course])).rows[0]
        .description_text,
    ).toBe('');
    expect(
      (await observer.query('SELECT content_json FROM lesson WHERE id=$1', [lesson])).rows[0].content_json,
    ).toBeNull();
  });

  it('rejects stale review after a concurrent edit, without losing the newer edit', async () => {
    const review = await plan();
    await observer.query(`UPDATE course SET title='Newer author change' WHERE id=$1`, [course]);
    const before = await snapshot();
    await expect(apply(review.reviewDigest)).rejects.toThrow('stale');
    expect(await snapshot()).toEqual(before);
  });

  it('binds review to source bytes and the platform owner', async () => {
    const review = await plan();
    const modified = changedEntry('course', (rows) => {
      rows[0]!.title = 'Different reviewed source';
    });
    const before = await snapshot();
    await expect(apply(review.reviewDigest, modified)).rejects.toThrow('stale');
    await expect(
      asStaff(
        () =>
          applySchoolContentRecovery(prisma, h.tenants.acme, archive, {
            digest: review.reviewDigest,
            ...approval,
          }),
        otherOwnerId,
      ),
    ).rejects.toThrow('stale');
    await expect(
      runWithContext({ requestId: 'school-session', userId: ownerId }, () =>
        planSchoolContentRecovery(prisma, h.tenants.acme, archive),
      ),
    ).rejects.toThrow();
    await expect(
      asStaff(() => planSchoolContentRecovery(prisma, h.tenants.acme, archive), supportId),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a different school, forged tenant ids, duplicate ids and unsafe rich content', async () => {
    const before = await snapshot();
    await expect(plan(archive, h.tenants.beta)).rejects.toThrow('mismatch');
    await expect(
      plan(
        changedEntry('course', (rows) => {
          rows[0]!.tenant_id = h.tenants.beta;
        }),
      ),
    ).rejects.toThrow('Foreign');
    await expect(
      plan(
        changedEntry('course', (rows) => {
          rows.push(rows[0]!);
        }),
      ),
    ).rejects.toThrow('duplicate');
    await expect(
      plan(
        changedEntry('lesson', (rows) => {
          rows[0]!.content_json = { type: 'script', text: 'alert(1)' };
        }),
      ),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('blocks missing records and foreign parents before changing any record', async () => {
    const missing = changedEntry('lesson', (rows) => {
      rows[0]!.id = randomUUID();
    });
    const parent = changedEntry('section', (rows) => {
      rows[0]!.course_id = ref('course', h.tenants.beta);
    });
    for (const entries of [missing, parent]) {
      const review = await plan(entries);
      expect(review.blockers).toHaveLength(1);
      const before = await snapshot();
      await expect(apply(review.reviewDigest, entries)).rejects.toThrow('blocked');
      expect(await snapshot()).toEqual(before);
    }
  });

  it('ignores protected export fields and preserves newer records rather than rolling them back', async () => {
    const entries = changedEntry('course', (rows) => {
      rows[0]!.price_minor = 999999;
      rows[0]!.owner_membership_id = ref('tenant_membership', h.tenants.beta);
    });
    const before = (
      await observer.query('SELECT price_minor, owner_membership_id FROM course WHERE id=$1', [course])
    ).rows;
    const newerId = randomUUID();
    await observer.query(
      `INSERT INTO section (id,tenant_id,course_id,title,position) VALUES ($1,$2,$3,'Newer section',100)`,
      [newerId, h.tenants.acme, course],
    );
    const review = await plan(entries);
    await apply(review.reviewDigest, entries);
    expect(
      (await observer.query('SELECT price_minor, owner_membership_id FROM course WHERE id=$1', [course]))
        .rows,
    ).toEqual(before);
    expect((await observer.query('SELECT title FROM section WHERE id=$1', [newerId])).rows[0].title).toBe(
      'Newer section',
    );
  });

  it('rolls back recovered content and school audit if platform audit insertion fails', async () => {
    const review = await plan();
    const before = await snapshot();
    await observer.query('REVOKE INSERT ON platform_audit_log FROM studyhub_app');
    try {
      await expect(apply(review.reviewDigest)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await observer.query('GRANT INSERT ON platform_audit_log TO studyhub_app');
    }
  });
});
