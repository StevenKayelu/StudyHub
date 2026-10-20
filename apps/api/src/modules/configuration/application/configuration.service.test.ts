import { describe, expect, it } from 'vitest';

import { configurationViewSchema, type ConfigurationDraftRequest } from '@studyhub/contracts';

import { requireTenantId, runWithContext, type TenantDb, type TenantTx } from '../../platform';
import { CONTENT_DEFAULTS_KEY, readContentSettings } from '../../tenancy';
import { ConfigurationService } from './configuration.service';

const ACME = '10000000-0000-4000-8000-000000000001';
const BETA = '10000000-0000-4000-8000-000000000002';
const actor = {
  userId: '20000000-0000-4000-8000-000000000001',
  membershipId: '30000000-0000-4000-8000-000000000001',
};
const school = <T>(id: string, fn: () => T) =>
  runWithContext({ requestId: 'configuration-unit', tenantId: id }, fn);

/** Transactional persistence double for workflow tests; real PostgreSQL/RLS is covered separately. */
function fixture() {
  let platform = new Map<string, unknown>();
  let schools = new Map([
    [ACME, new Map<string, unknown>()],
    [BETA, new Map<string, unknown>()],
  ]);
  type Entry = {
    id: bigint;
    createdAt: Date;
    actorId: string;
    action: string;
    entityType: string;
    before?: object;
    after: object;
  };
  let logs = new Map<string, Entry[]>();
  let nextId = 1n;
  type Where = { key?: string | { in: string[] }; action?: string; entityType?: string };
  const row = (map: Map<string, unknown>, key: string) =>
    map.has(key) ? { key, value: map.get(key) } : null;
  const table = (map: Map<string, unknown>) => ({
    findUnique: async ({ where }: { where: { key: string } }) => row(map, where.key),
    findFirst: async ({ where }: { where: { key: string } }) => row(map, where.key),
    findMany: async ({ where }: { where: Where }) =>
      [...map]
        .filter(([key]) =>
          typeof where.key === 'string' ? key === where.key : (where.key?.in.includes(key) ?? true),
        )
        .map(([key, value]) => ({ key, value })),
    upsert: async ({ create }: { create: { key: string; value: unknown } }) => {
      map.set(create.key, structuredClone(create.value));
      return row(map, create.key);
    },
    delete: async ({ where }: { where: { key: string } }) => {
      map.delete(where.key);
    },
    deleteMany: async ({ where }: { where: { key: string } }) => ({ count: map.delete(where.key) ? 1 : 0 }),
  });
  const tx = (scope: string): TenantTx => {
    const schoolMap = schools.get(scope) ?? new Map();
    const audit = {
      create: async ({ data }: { data: Omit<Entry, 'id' | 'createdAt'> }) => {
        const entries = logs.get(scope) ?? [];
        const created = { ...structuredClone(data), id: nextId++, createdAt: new Date() };
        entries.push(created);
        logs.set(scope, entries);
        return created;
      },
      findMany: async ({ where, take }: { where: Where; take: number }) =>
        (logs.get(scope) ?? [])
          .filter((entry) => entry.action === where.action && entry.entityType === where.entityType)
          .slice()
          .reverse()
          .slice(0, take),
    };
    return {
      platformSetting: table(platform),
      tenantSetting: table(schoolMap),
      platformAuditLog: audit,
      auditLog: audit,
      $executeRaw: async () => 1,
    } as unknown as TenantTx;
  };
  async function transaction<T>(scope: string, fn: (value: TenantTx) => Promise<T>) {
    const before = structuredClone({ platform, schools, logs });
    try {
      return await fn(tx(scope));
    } catch (error) {
      platform = before.platform;
      schools = before.schools;
      logs = before.logs;
      throw error;
    }
  }
  const db = {
    run: <T>(fn: (value: TenantTx) => Promise<T>) => transaction(requireTenantId(), fn),
    runPlatform: <T>(fn: (value: TenantTx) => Promise<T>) => transaction('PLATFORM', fn),
  } as TenantDb;
  return { service: new ConfigurationService(db), db, platform: () => platform, logs: () => logs };
}

async function change(
  f: ReturnType<typeof fixture>,
  scope: 'SCHOOL' | 'PLATFORM',
  values: ConfigurationDraftRequest['values'],
  lockedKeys: ConfigurationDraftRequest['lockedKeys'] = [],
) {
  const current = await f.service.get(scope);
  const saved = await f.service.saveDraft(scope, actor, {
    expectedRevision: current.revision,
    values,
    lockedKeys,
    reason: 'Reviewed local policy change',
  });
  return f.service.activate(scope, actor, { draftId: saved.draft!.id, expectedRevision: saved.revision });
}

describe('reviewed configuration activation', () => {
  it('demonstrates Acme-only changes, inherited Beta defaults, reset and first-change history restore', async () => {
    const f = fixture();
    await change(f, 'PLATFORM', { courseReviewRequired: false });
    const initial = await school(ACME, () => f.service.get('SCHOOL'));
    const saved = await school(ACME, () =>
      f.service.saveDraft('SCHOOL', actor, {
        expectedRevision: initial.revision,
        values: { courseReviewRequired: true },
        lockedKeys: [],
        reason: 'Acme requires review',
      }),
    );
    expect(saved.fields.find((field) => field.key === 'courseReviewRequired')!.value).toBe(false);
    const activated = await school(ACME, () =>
      f.service.activate('SCHOOL', actor, { draftId: saved.draft!.id, expectedRevision: saved.revision }),
    );
    configurationViewSchema.parse(activated);
    expect(activated.history).toHaveLength(2);
    expect(activated.history.at(-1)!.values).toEqual({});
    const acme = await school(ACME, () => f.db.run(readContentSettings));
    const beta = await school(BETA, () => f.db.run(readContentSettings));
    expect(acme.courseReviewRequired).toBe(true);
    expect(beta.courseReviewRequired).toBe(false);
    expect((await school(BETA, () => f.service.get('SCHOOL'))).history).toEqual([]);
    await school(ACME, () => change(f, 'SCHOOL', activated.history.at(-1)!.values));
    expect((await school(ACME, () => f.db.run(readContentSettings))).courseReviewRequired).toBe(false);
  });

  it('refuses replaced drafts, other-school revision tokens and changed platform policy without mutation', async () => {
    const f = fixture();
    const current = await school(ACME, () => f.service.get('SCHOOL'));
    const input = {
      expectedRevision: current.revision,
      values: { courseReviewRequired: false },
      lockedKeys: [],
      reason: 'Local policy',
    };
    const first = await school(ACME, () => f.service.saveDraft('SCHOOL', actor, input));
    const second = await school(ACME, () => f.service.saveDraft('SCHOOL', actor, input));
    await expect(
      school(ACME, () =>
        f.service.activate('SCHOOL', actor, { draftId: first.draft!.id, expectedRevision: current.revision }),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(school(BETA, () => f.service.saveDraft('SCHOOL', actor, input))).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await change(f, 'PLATFORM', { catalogVisibility: 'MEMBERS_ONLY' });
    await expect(
      school(ACME, () =>
        f.service.activate('SCHOOL', actor, {
          draftId: second.draft!.id,
          expectedRevision: current.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const after = await school(ACME, () => f.service.get('SCHOOL'));
    expect(after.values).toEqual({});
    expect(after.draft?.stale).toBe(true);
    expect(after.history).toEqual([]);
  });

  it('enforces platform restrictions while retaining old overrides and allowing reset', async () => {
    const f = fixture();
    await school(ACME, () => change(f, 'SCHOOL', { courseReviewRequired: false }));
    await change(f, 'PLATFORM', { courseReviewRequired: true }, ['courseReviewRequired']);
    const state = await school(ACME, () => f.service.get('SCHOOL'));
    expect(state.fields.find((field) => field.key === 'courseReviewRequired')).toMatchObject({
      value: true,
      overrideValue: false,
      source: 'PLATFORM_ENFORCED',
    });
    await expect(
      school(ACME, () =>
        f.service.saveDraft('SCHOOL', actor, {
          expectedRevision: state.revision,
          values: { courseReviewRequired: true },
          lockedKeys: [],
          reason: 'Attempt locked edit',
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      school(ACME, () =>
        f.service.saveDraft('SCHOOL', actor, {
          expectedRevision: state.revision,
          values: {},
          lockedKeys: ['catalogVisibility'],
          reason: 'Attempt platform lock',
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await school(ACME, () => change(f, 'SCHOOL', {}));
    expect((await school(ACME, () => f.service.get('SCHOOL'))).values).toEqual({});
    await change(f, 'PLATFORM', { courseReviewRequired: false });
    expect((await school(ACME, () => f.db.run(readContentSettings))).courseReviewRequired).toBe(false);
  });

  it('rejects credential import without persisting raw files or secret values', () => {
    const f = fixture();
    expect(() => f.service.importPreview('S3_SECRET_ACCESS_KEY=never-persist-this')).toThrow();
    expect(f.platform().size).toBe(0);
    expect(f.logs().size).toBe(0);
    f.platform().set(CONTENT_DEFAULTS_KEY, null);
    return expect(f.service.get('PLATFORM')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
