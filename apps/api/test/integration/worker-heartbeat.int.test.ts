import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLogger,
  createRuntimeBoss,
  DEFAULT_JOB_HANDLERS,
  enqueue,
  HEARTBEAT_JOB,
  type JobEnvelope,
  type JobHandler,
  startWorker,
} from '../../src/modules/platform';
import { startTestDatabase, type TestDatabase } from '../setup/postgres-container';

async function waitForState(
  boss: PgBoss,
  id: string,
  states: readonly string[],
  timeoutMs = 30_000,
): Promise<{ state: string; retryCount: number; output: unknown }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await boss.getJobById(HEARTBEAT_JOB, id);
    if (job !== null && states.includes(job.state)) return job;
    if (Date.now() > deadline)
      throw new Error(`job ${id} did not reach ${states.join('/')} (last: ${job?.state})`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('background worker (pg-boss as the app role)', () => {
  let database: TestDatabase;
  let worker: PgBoss;
  let producer: PgBoss;
  const handled: JobEnvelope[] = [];
  const queueErrors: unknown[] = [];

  beforeAll(async () => {
    database = await startTestDatabase({ migrate: true });
    const logger = createLogger({ level: 'silent' });

    const realHandler = DEFAULT_JOB_HANDLERS[HEARTBEAT_JOB];
    if (realHandler === undefined) throw new Error('heartbeat handler is not registered');
    const spy: JobHandler = async (envelope, jobLogger) => {
      handled.push(envelope);
      return realHandler(envelope, jobLogger);
    };

    worker = await startWorker({
      connectionString: database.appUrl,
      logger,
      handlers: { [HEARTBEAT_JOB]: spy },
      pollingIntervalSeconds: 1,
    });
    worker.on('error', (error) => queueErrors.push(error));

    producer = createRuntimeBoss(database.appUrl);
    producer.on('error', (error) => queueErrors.push(error));
    await producer.start();
  });

  afterAll(async () => {
    await producer?.stop({ graceful: false, close: true });
    await worker?.stop({ graceful: false, close: true });
    await database?.stop();
  });

  it('processes an enqueued system.heartbeat job', async () => {
    const id = await enqueue(
      producer,
      HEARTBEAT_JOB,
      { sentAt: new Date().toISOString() },
      'req_heartbeat_test',
    );
    const job = await waitForState(producer, id, ['completed', 'failed']);
    expect(job.state).toBe('completed');
    expect(job.output).toMatchObject({ receivedAt: expect.any(String) });
    expect(handled.some((envelope) => envelope.requestId === 'req_heartbeat_test')).toBe(true);
  });

  it('rejects a malformed envelope without running the handler or retrying', async () => {
    const before = handled.length;
    const id = await producer.send(HEARTBEAT_JOB, { not: 'an envelope' });
    expect(id).not.toBeNull();
    const job = await waitForState(producer, id as string, ['completed', 'failed']);
    expect(job.state).toBe('failed');
    expect(job.retryCount).toBe(0);
    expect(job.output).toMatchObject({ error: 'MALFORMED_ENVELOPE' });
    expect(handled.length).toBe(before);
  });

  it('retries a failing handler only up to the queue retry limit', async () => {
    // Valid envelope, invalid payload: the handler throws, so pg-boss retries (retryLimit 2), then fails.
    const id = await enqueue(producer, HEARTBEAT_JOB, { sentAt: 'not-a-timestamp' });
    const job = await waitForState(producer, id, ['completed', 'failed'], 45_000);
    expect(job.state).toBe('failed');
    expect(job.retryCount).toBe(2);
  });

  it('refuses to start for a queue that was never migrated', async () => {
    await expect(
      startWorker({
        connectionString: database.appUrl,
        logger: createLogger({ level: 'silent' }),
        handlers: { 'system.not-migrated': async () => undefined },
      }),
    ).rejects.toThrow(/pnpm db:migrate/);
  });

  it('runs as the app role without permission errors', () => {
    expect(queueErrors).toEqual([]);
  });
});
