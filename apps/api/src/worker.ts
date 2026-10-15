import {
  ConfigError,
  createEmailHandler,
  createLogger,
  createMailTransport,
  createMediaPorts,
  DEFAULT_JOB_HANDLERS,
  dispatchDueOutbox,
  EMAIL_SEND_JOB,
  loadApiEnv,
  PrismaService,
  SecretBox,
  startWorker,
} from './modules/platform';
import { AUTO_SUBMIT_JOB, createAutoSubmitHandler } from './modules/assessment';
import { createProcessAssetHandler, MEDIA_PROCESS_JOB } from './modules/media';

const OUTBOX_INTERVAL_MS = 2000;

/** Background worker process: same codebase as the API, separate entry point (blueprint 04 §2). */
async function main(): Promise<void> {
  const env = loadApiEnv();
  const logger = createLogger({ level: env.LOG_LEVEL }).child({ process: 'worker' });
  // Runtime role (studyhub_app) under RLS; the outbox sweep uses only the claim_due_outbox() definer function.
  const prisma = new PrismaService(env, logger);
  const media = createMediaPorts(env);
  const handlers = {
    ...DEFAULT_JOB_HANDLERS,
    [EMAIL_SEND_JOB]: createEmailHandler(
      new SecretBox(env.IDENTITY_ENCRYPTION_KEY),
      createMailTransport(env.SMTP_URL),
      env.MAIL_FROM_ADDRESS,
    ),
    [MEDIA_PROCESS_JOB]: createProcessAssetHandler({
      prisma,
      storage: media.storage,
      scanner: media.scanner,
    }),
    [AUTO_SUBMIT_JOB]: createAutoSubmitHandler({ prisma }),
  };
  const boss = await startWorker({ connectionString: env.DATABASE_URL_APP, logger, handlers });

  let sweeping = false;
  const outboxTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    dispatchDueOutbox({ prisma, boss, logger })
      .catch((error: unknown) => logger.error({ err: error }, 'Outbox sweep failed'))
      .finally(() => {
        sweeping = false;
      });
  }, OUTBOX_INTERVAL_MS);
  logger.info('Worker started');

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(outboxTimer);
    logger.info({ signal }, 'Worker stopping');
    boss
      .stop({ graceful: true, timeout: 10_000 })
      .then(() => prisma.onModuleDestroy())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Worker failed to stop cleanly');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : `Worker failed to start: ${String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
