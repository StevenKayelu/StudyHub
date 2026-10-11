import { PgBoss } from 'pg-boss';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addToOutbox,
  createLogger,
  createRuntimeBoss,
  dispatchDueOutbox,
  enqueue,
  JOB_SCHEMA,
  type JobEnvelope,
  type JobHandler,
  loadApiEnv,
  PrismaService,
  requireTenantId,
  runInTenantTx,
  runWithContext,
  startWorker,
} from '../../src/modules/platform';
import { provisionTenant } from '../../src/modules/tenancy';
import { startTestDatabase, type TestDatabase } from '../setup/postgres-container';

const PROBE_QUEUE = 'test.tenant-probe';

interface ProbeResult {
  contextTenant: string;
  visibleTenants: string[];
}

async function waitForState(boss: PgBoss, id: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await boss.getJobById<unknown>(PROBE_QUEUE, id);
    if (job !== null && (job.state === 'completed' || job.state === 'failed')) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} did not finish (last: ${job?.state})`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('tenant context in background jobs (T-ISO-17, T-ISO-18)', () => {
  let database: TestDatabase;
  let migrator: Client;
  let prisma: PrismaService;
  let worker: PgBoss;
  let producer: PgBoss;
  let tenantA: string;
  let tenantB: string;
  const handled: Array<{ envelope: JobEnvelope; result: ProbeResult }> = [];

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

    // Test-only queue, created like real queues: by the migrator (DDL), never by the runtime role.
    const installer = new PgBoss({
      connectionString: database.migratorUrl,
      schema: JOB_SCHEMA,
      supervise: false,
      schedule: false,
    });
    await installer.start();
    await installer.createQueue(PROBE_QUEUE, { retryLimit: 0 });
    await installer.stop({ graceful: false, close: true });

    const env = loadApiEnv({ DATABASE_URL_APP: database.appUrl, LOG_LEVEL: 'silent' });
    const logger = createLogger({ level: 'silent' });
    prisma = new PrismaService(env, logger);

    const probe: JobHandler = async (envelope) => {
      const result: ProbeResult = await runInTenantTx(prisma, async (tx) => ({
        contextTenant: requireTenantId(),
        visibleTenants: [
          ...new Set((await tx.auditLog.findMany({ select: { tenantId: true } })).map((r) => r.tenantId)),
        ],
      }));
      handled.push({ envelope, result });
      return result;
    };
    worker = await startWorker({
      connectionString: database.appUrl,
      logger,
      handlers: { [PROBE_QUEUE]: probe },
      pollingIntervalSeconds: 1,
    });
    producer = createRuntimeBoss(database.appUrl);
    await producer.start();
  });

  afterAll(async () => {
    await producer?.stop({ graceful: false, close: true });
    await worker?.stop({ graceful: false, close: true });
    await prisma?.onModuleDestroy();
    await migrator?.end();
    await database?.stop();
  });

  it('T-ISO-17: a tenant job runs inside its own tenant context and sees only that tenant', async () => {
    const id = await runWithContext({ requestId: 'req_job_a', tenantId: tenantA }, () =>
      enqueue(producer, PROBE_QUEUE, {}),
    );
    const job = await waitForState(producer, id);
    expect(job.state).toBe('completed');
    expect(job.output).toEqual({ contextTenant: tenantA, visibleTenants: [tenantA] });
  });

  it('T-ISO-17: a tenant job without a tenantId is dead-lettered without running', async () => {
    const before = handled.length;
    const id = await producer.send(PROBE_QUEUE, {
      type: PROBE_QUEUE,
      tenantId: null,
      payload: {},
      requestId: 'r-no-tenant',
    });
    const job = await waitForState(producer, id as string);
    expect(job.state).toBe('failed');
    expect(job.output).toMatchObject({ error: 'MALFORMED_ENVELOPE' });
    expect(handled.length).toBe(before);
  });

  it('T-ISO-17: enqueue refuses to create a tenant job outside a tenant context', async () => {
    await expect(enqueue(producer, PROBE_QUEUE, {})).rejects.toThrow();
  });

  it('T-ISO-18: the outbox dispatcher claims across tenants but sends each job in its own tenant', async () => {
    await runWithContext({ requestId: 'req_outbox_a', tenantId: tenantA }, () =>
      runInTenantTx(prisma, (tx) => addToOutbox(tx, PROBE_QUEUE, { from: 'a' })),
    );
    await runWithContext({ requestId: 'req_outbox_b', tenantId: tenantB }, () =>
      runInTenantTx(prisma, (tx) => addToOutbox(tx, PROBE_QUEUE, { from: 'b' })),
    );
    const before = handled.length;
    const dispatched = await dispatchDueOutbox({
      prisma,
      boss: producer,
      logger: createLogger({ level: 'silent' }),
    });
    expect(dispatched).toBe(2);

    const deadline = Date.now() + 30_000;
    while (handled.length < before + 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    const fromOutbox = handled.slice(before);
    expect(fromOutbox).toHaveLength(2);
    for (const { envelope, result } of fromOutbox) {
      const expectedTenant = envelope.payload.from === 'a' ? tenantA : tenantB;
      expect(envelope.tenantId).toBe(expectedTenant);
      expect(result).toEqual({ contextTenant: expectedTenant, visibleTenants: [expectedTenant] });
    }

    // Each row was marked dispatched inside its own tenant; nothing is left to claim.
    expect(
      await dispatchDueOutbox({ prisma, boss: producer, logger: createLogger({ level: 'silent' }) }),
    ).toBe(0);
  });
});
