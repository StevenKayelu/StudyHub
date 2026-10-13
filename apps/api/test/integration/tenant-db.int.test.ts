import { PrismaPg } from '@prisma/adapter-pg';
import { type Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AppError,
  createLogger,
  loadApiEnv,
  PrismaService,
  runInTenantTx,
  runWithContext,
} from '../../src/modules/platform';
import { PrismaClient } from '../../src/generated/prisma/client';
import { provisionTenant } from '../../src/modules/tenancy';
import { startTestDatabase, type TestDatabase } from '../setup/postgres-container';

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

describe('tenant-scoped transactions (runInTenantTx)', () => {
  let database: TestDatabase;
  let migrator: Client;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    database = await startTestDatabase({ migrate: true });
    migrator = await database.connect(database.migratorUrl);
    const a = await provisionTenant(migrator, {
      slug: 'acme',
      name: 'Acme Academy',
      kind: 'SCHOOL',
      hostname: 'acme.localhost',
      status: 'ACTIVE',
    });
    const b = await provisionTenant(migrator, {
      slug: 'beta',
      name: 'Beta College',
      kind: 'COLLEGE',
      hostname: 'beta.localhost',
      status: 'ACTIVE',
    });
    if (a.outcome !== 'created' || b.outcome !== 'created') throw new Error('provisioning failed');
    tenantA = a.tenantId;
    tenantB = b.tenantId;
    const env = loadApiEnv({ DATABASE_URL_APP: database.appUrl, LOG_LEVEL: 'silent' });
    prisma = new PrismaService(env, createLogger({ level: 'silent' }));
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await migrator?.end();
    await database?.stop();
  });

  it('throws TENANT_CONTEXT_MISSING without a tenant context, before touching the database', async () => {
    const attempt = runInTenantTx(prisma, (tx) => tx.auditLog.count());
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(runInTenantTx(prisma, (tx) => tx.auditLog.count())).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_MISSING',
    });
  });

  it('sees only the current tenant, even with an unfiltered query', async () => {
    const asA = await runWithContext({ requestId: 'r-a', tenantId: tenantA }, () =>
      runInTenantTx(prisma, (tx) => tx.auditLog.findMany({ select: { tenantId: true } })),
    );
    expect(asA.length).toBeGreaterThan(0);
    expect(new Set(asA.map((row) => row.tenantId))).toEqual(new Set([tenantA]));

    const tenantsVisibleToB = await runWithContext({ requestId: 'r-b', tenantId: tenantB }, () =>
      runInTenantTx(prisma, (tx) => tx.tenant.findMany({ select: { id: true } })),
    );
    expect(tenantsVisibleToB).toEqual([{ id: tenantB }]);
  });

  it('rejects writing a row for another tenant (RLS WITH CHECK)', async () => {
    const forged = runWithContext({ requestId: 'r-forge', tenantId: tenantB }, () =>
      runInTenantTx(prisma, (tx) =>
        tx.auditLog.create({ data: { tenantId: tenantA, action: 'iso.forged', entityType: 'test' } }),
      ),
    );
    await expect(forged).rejects.toThrow();
  });

  it('keeps contexts separate across interleaved concurrent requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const tenantId = index % 2 === 0 ? tenantA : tenantB;
        return runWithContext({ requestId: `r-${index}`, tenantId }, () =>
          runInTenantTx(prisma, async (tx) => ({
            expected: tenantId,
            seen: (await tx.tenant.findMany({ select: { id: true } })).map((t) => t.id),
          })),
        );
      }),
    );
    for (const result of results) expect(result.seen).toEqual([result.expected]);
  });

  it('T-PERF-01 (D5, revised): the tenant context adds exactly one statement and <0.5 ms database time', async () => {
    // 1) Deterministic: count statements sent over the wire with a counting pg pool.
    let statements = 0;
    const pool = new Pool({ connectionString: database.appUrl, max: 1 });
    pool.on('connect', (client) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        statements += 1;
        return original(...args);
      };
    });
    const counted = new PrismaClient({ adapter: new PrismaPg(pool) });
    try {
      await counted.$queryRaw`SELECT 1`; // open the connection outside the measurement
      const countStatements = async (run: () => Promise<unknown>) => {
        const before = statements;
        await run();
        return statements - before;
      };
      const plainStatements = await countStatements(() =>
        counted.$transaction(async (tx) => tx.$queryRaw`SELECT 1`),
      );
      const scopedStatements = await countStatements(() =>
        runWithContext({ requestId: 'count', tenantId: tenantA }, () =>
          runInTenantTx(counted, (tx) => tx.$queryRaw`SELECT 1`),
        ),
      );

      // 2) Database time of the context statement (median of 21 EXPLAIN ANALYZE runs, network excluded).
      const serverTimes: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        const plan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
          EXPLAIN (ANALYZE, FORMAT TEXT) SELECT set_config('app.tenant_id', ${tenantA}::text, true), set_config('app.user_id', ''::text, true)`;
        const line =
          plan.map((row) => row['QUERY PLAN']).find((text) => text.startsWith('Execution Time')) ?? '';
        serverTimes.push(Number(/([\d.]+) ms/.exec(line)?.[1] ?? Number.NaN));
      }

      // 3) Timing sanity: the measured overhead looks like one network round trip, not several.
      const iterations = 300;
      const plain: number[] = [];
      const scoped: number[] = [];
      const roundTrip: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        await prisma.$transaction(async (tx) => tx.$queryRaw`SELECT 1`);
        await runWithContext({ requestId: 'warm', tenantId: tenantA }, () =>
          runInTenantTx(prisma, (tx) => tx.$queryRaw`SELECT 1`),
        );
      }
      for (let i = 0; i < iterations; i += 1) {
        let started = performance.now();
        await prisma.$transaction(async (tx) => tx.$queryRaw`SELECT 1`);
        plain.push(performance.now() - started);
        started = performance.now();
        await runWithContext({ requestId: 'bench', tenantId: tenantA }, () =>
          runInTenantTx(prisma, (tx) => tx.$queryRaw`SELECT 1`),
        );
        scoped.push(performance.now() - started);
        started = performance.now();
        await prisma.$queryRaw`SELECT 1`;
        roundTrip.push(performance.now() - started);
      }

      const report = {
        plainStatements,
        scopedStatements,
        extraStatements: scopedStatements - plainStatements,
        setConfigServerMsMedian: percentile(serverTimes, 50),
        roundTripP50: percentile(roundTrip, 50),
        overheadP50: percentile(scoped, 50) - percentile(plain, 50),
        overheadP95: percentile(scoped, 95) - percentile(plain, 95),
      };
      process.stdout.write(`T-PERF-01 ${JSON.stringify(report)}\n`);

      expect(report.extraStatements).toBe(1);
      expect(report.setConfigServerMsMedian).toBeLessThan(0.5);
      expect(report.overheadP50).toBeLessThanOrEqual(1.5 * report.roundTripP50 + 0.5);
    } finally {
      await counted.$disconnect();
      await pool.end();
    }
  });
});
