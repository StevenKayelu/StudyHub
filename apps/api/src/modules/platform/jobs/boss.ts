import { type Job, type JobResult, PgBoss, type Queue } from 'pg-boss';
import { Client } from 'pg';
import type { Logger } from 'pino';

import { EMAIL_SEND_JOB } from '../mail/email.job';
import { handleHeartbeat, HEARTBEAT_JOB } from './heartbeat.job';
import { runWithContext } from '../context/request-context';
import { createEnvelope, type EnvelopeOptions, type JobEnvelope, jobEnvelopeSchema } from './job-envelope';

/** pg-boss lives in its own schema, created and owned by the migrator role. */
export const JOB_SCHEMA = 'pgboss';

/** Every queue the system uses. Created by `pnpm db:migrate` (DDL), never by the worker. */
export const QUEUE_DEFINITIONS: ReadonlyArray<Omit<Queue, 'name'> & { name: string }> = [
  { name: HEARTBEAT_JOB, retryLimit: 2, retryDelay: 1, retentionSeconds: 7 * 24 * 3600 },
  // Emails: SMTP outages are retried with backoff for about an hour.
  {
    name: EMAIL_SEND_JOB,
    retryLimit: 6,
    retryDelay: 30,
    retryBackoff: true,
    retentionSeconds: 7 * 24 * 3600,
  },
  // Uploads: verify, scan, derive (the media module's MEDIA_PROCESS_JOB).
  {
    name: 'media.process',
    retryLimit: 5,
    retryDelay: 10,
    retryBackoff: true,
    retentionSeconds: 7 * 24 * 3600,
  }, // Quiz attempts submitted at their deadline (the assessment module's AUTO_SUBMIT_JOB, F19 AC 3).
  {
    name: 'assessment.auto-submit',
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    retentionSeconds: 7 * 24 * 3600,
  },
  // Commerce (M8): webhook events, reconciliation (W5), order expiry, ledger release and check (W6).
  // Provider outages are retried with backoff; every handler is idempotent.
  ...['commerce.payment-event', 'commerce.payment-check'].map((name) => ({
    name,
    retryLimit: 8,
    retryDelay: 15,
    retryBackoff: true,
    retentionSeconds: 14 * 24 * 3600,
  })),
  // Deposit plans: balance reminders before and on the deadline (docs/design/payment-plans.md).
  ...[
    'commerce.order-expire',
    'commerce.ledger-release',
    'commerce.ledger-check',
    'commerce.balance-reminder',
  ].map((name) => ({
    name,
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    retentionSeconds: 14 * 24 * 3600,
  })),
  // School administration (M9): exports (F32, F46), daily usage metering (F47) and offboarding purges
  // (F46). Exports are heavy, so at most a few run at once (NFR-ISO-2).
  {
    name: 'admin.export',
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    retentionSeconds: 14 * 24 * 3600,
  },
  {
    name: 'admin.usage-meter',
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    retentionSeconds: 3 * 24 * 3600,
  },
  // SaaS billing (docs/design/saas-billing.md): each school's billing cycle and invoice reminders.
  ...['billing.cycle', 'billing.notice'].map((name) => ({
    name,
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    retentionSeconds: 14 * 24 * 3600,
  })),
  {
    name: 'admin.tenant-purge',
    retryLimit: 3,
    retryDelay: 300,
    retryBackoff: true,
    retentionSeconds: 30 * 24 * 3600,
  },
];

export type JobHandler = (envelope: JobEnvelope, logger: Logger) => Promise<unknown>;

export const DEFAULT_JOB_HANDLERS: Readonly<Record<string, JobHandler>> = {
  [HEARTBEAT_JOB]: handleHeartbeat,
};

/**
 * Installs or upgrades the pg-boss schema and queues as the migrator, then grants the runtime
 * role data access only. Idempotent; part of `pnpm db:migrate`.
 */
export async function installJobSchema(migratorUrl: string, appRole = 'studyhub_app'): Promise<void> {
  const boss = new PgBoss({
    connectionString: migratorUrl,
    schema: JOB_SCHEMA,
    application_name: 'studyhub-migrate',
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });
  boss.on('error', () => undefined); // surfaced through the awaited calls below
  await boss.start();
  try {
    for (const { name, ...options } of QUEUE_DEFINITIONS) {
      if ((await boss.getQueue(name)) === null) {
        await boss.createQueue(name, options);
      }
    }
  } finally {
    await boss.stop({ graceful: false, close: true });
  }

  const client = new Client({ connectionString: migratorUrl, application_name: 'studyhub-migrate' });
  await client.connect();
  try {
    const role = client.escapeIdentifier(appRole);
    const schema = client.escapeIdentifier(JOB_SCHEMA);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`,
    );
  } finally {
    await client.end();
  }
}

/** A pg-boss client for the runtime role: never migrates, never creates schemas. */
export function createRuntimeBoss(connectionString: string, options: { supervise?: boolean } = {}): PgBoss {
  return new PgBoss({
    connectionString,
    schema: JOB_SCHEMA,
    application_name: 'studyhub-worker',
    migrate: false,
    createSchema: false,
    supervise: options.supervise ?? false,
    schedule: false,
  });
}

/**
 * Validate and enqueue a job. Tenant jobs take the tenant from the current context unless one is
 * given explicitly; system jobs (`system.*`) never carry a tenant. Returns the job id.
 */
export async function enqueue(
  boss: PgBoss,
  type: string,
  payload: Record<string, unknown>,
  options: EnvelopeOptions = {},
): Promise<string> {
  const id = await boss.send(type, createEnvelope(type, payload, options));
  if (id === null) throw new Error(`Job ${type} was not enqueued`);
  return id;
}

export interface StartWorkerOptions {
  connectionString: string;
  logger: Logger;
  handlers?: Readonly<Record<string, JobHandler>>;
  pollingIntervalSeconds?: number;
}

/**
 * Starts the background worker as the runtime role. Each job's envelope is validated first:
 * a malformed job (including a tenant job without a tenantId) is dead-lettered immediately, never
 * retried and never handed to the handler. Tenant jobs run inside their envelope's tenant context,
 * so every tenant-scoped query the handler makes is limited by RLS to that tenant (threat T12).
 * A handler error fails the job so pg-boss retries it up to the queue's retryLimit.
 */
export async function startWorker(options: StartWorkerOptions): Promise<PgBoss> {
  const handlers = options.handlers ?? DEFAULT_JOB_HANDLERS;
  const boss = createRuntimeBoss(options.connectionString, { supervise: true });
  boss.on('error', (error) => options.logger.error({ err: error }, 'Job queue error'));
  await boss.start();

  for (const [type, handler] of Object.entries(handlers)) {
    if ((await boss.getQueue(type)) === null) {
      await boss.stop({ graceful: false, close: true });
      throw new Error(`Queue "${type}" does not exist. Run \`pnpm db:migrate\` first.`);
    }
    await boss.work<unknown>(
      type,
      { perJobResults: true, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 },
      async (jobs: Job<unknown>[]): Promise<JobResult[]> => {
        const results: JobResult[] = [];
        for (const job of jobs) {
          const parsed = jobEnvelopeSchema.safeParse(job.data);
          if (!parsed.success || parsed.data.type !== type) {
            options.logger.warn({ jobId: job.id, queue: type }, 'Malformed job envelope rejected');
            results.push({ id: job.id, status: 'deadletter', output: { error: 'MALFORMED_ENVELOPE' } });
            continue;
          }
          const envelope = parsed.data;
          const context =
            envelope.tenantId === null
              ? { requestId: envelope.requestId }
              : { requestId: envelope.requestId, tenantId: envelope.tenantId };
          const jobLogger = options.logger.child({
            requestId: envelope.requestId,
            ...(envelope.tenantId !== null && { tenantId: envelope.tenantId }),
          });
          try {
            const output = await runWithContext(context, () => handler(envelope, jobLogger));
            results.push({ id: job.id, status: 'completed', output: output ?? null });
          } catch (error) {
            options.logger.error({ err: error, jobId: job.id, queue: type }, 'Job failed');
            results.push({ id: job.id, status: 'failed', output: { error: 'HANDLER_FAILED' } });
          }
        }
        return results;
      },
    );
  }
  return boss;
}
