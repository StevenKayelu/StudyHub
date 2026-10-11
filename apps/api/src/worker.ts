import {
  ConfigError,
  createLogger,
  dispatchDueOutbox,
  loadApiEnv,
  PrismaService,
  startWorker,
} from './modules/platform';

const OUTBOX_INTERVAL_MS = 2000;

/** Background worker process: same codebase as the API, separate entry point (blueprint 04 §2). */
async function main(): Promise<void> {
  const env = loadApiEnv();
  const logger = createLogger({ level: env.LOG_LEVEL }).child({ process: 'worker' });
  const boss = await startWorker({ connectionString: env.DATABASE_URL_APP, logger });
  // Runtime role (studyhub_app) under RLS; the outbox sweep uses only the claim_due_outbox() definer function.
  const prisma = new PrismaService(env, logger);

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
