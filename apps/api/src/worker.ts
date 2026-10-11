import { ConfigError, createLogger, loadApiEnv, startWorker } from './modules/platform';

/** Background worker process: same codebase as the API, separate entry point (blueprint 04 §2). */
async function main(): Promise<void> {
  const env = loadApiEnv();
  const logger = createLogger({ level: env.LOG_LEVEL }).child({ process: 'worker' });
  const boss = await startWorker({ connectionString: env.DATABASE_URL_APP, logger });
  logger.info('Worker started');

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Worker stopping');
    boss
      .stop({ graceful: true, timeout: 10_000 })
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
