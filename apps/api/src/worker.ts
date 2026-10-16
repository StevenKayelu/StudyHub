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
import {
  createExportHandler,
  createPurgeHandler,
  createUsageMeterHandler,
  EXPORT_JOB,
  PURGE_JOB,
  sweepTenants,
  USAGE_METER_JOB,
} from './modules/admin';
import { AUTO_SUBMIT_JOB, createAutoSubmitHandler } from './modules/assessment';
import { AuditService } from './modules/audit';
import {
  type CommerceDeps,
  createLedgerCheckHandler,
  createLedgerReleaseHandler,
  createOrderExpireHandler,
  createPaymentCheckHandler,
  createPaymentEventHandler,
  createPaymentGateway,
  enqueueDueLedgerChecks,
  LEDGER_CHECK_JOB,
  LEDGER_RELEASE_JOB,
  ORDER_EXPIRE_JOB,
  PAYMENT_CHECK_JOB,
  PAYMENT_EVENT_JOB,
} from './modules/commerce';
import { createProcessAssetHandler, MEDIA_PROCESS_JOB } from './modules/media';

const OUTBOX_INTERVAL_MS = 2000;
/** W6: schools due their daily ledger check are looked for every hour (and at start). */
const LEDGER_CHECK_INTERVAL_MS = 3600_000;

/** Background worker process: same codebase as the API, separate entry point (blueprint 04 §2). */
async function main(): Promise<void> {
  const env = loadApiEnv();
  const logger = createLogger({ level: env.LOG_LEVEL }).child({ process: 'worker' });
  // Runtime role (studyhub_app) under RLS; the outbox sweep uses only the claim_due_outbox() definer function.
  const prisma = new PrismaService(env, logger);
  const media = createMediaPorts(env);
  const box = new SecretBox(env.IDENTITY_ENCRYPTION_KEY);
  const commerce: CommerceDeps = {
    prisma,
    gateway: createPaymentGateway(env, prisma),
    box,
    schoolUrlTemplate: env.SCHOOL_URL_TEMPLATE,
    audit: new AuditService(),
  };
  const handlers = {
    ...DEFAULT_JOB_HANDLERS,
    [EMAIL_SEND_JOB]: createEmailHandler(box, createMailTransport(env.SMTP_URL), env.MAIL_FROM_ADDRESS),
    [MEDIA_PROCESS_JOB]: createProcessAssetHandler({
      prisma,
      storage: media.storage,
      scanner: media.scanner,
    }),
    [AUTO_SUBMIT_JOB]: createAutoSubmitHandler({ prisma }),
    [PAYMENT_EVENT_JOB]: createPaymentEventHandler(commerce),
    [PAYMENT_CHECK_JOB]: createPaymentCheckHandler(commerce),
    [ORDER_EXPIRE_JOB]: createOrderExpireHandler(commerce),
    [LEDGER_RELEASE_JOB]: createLedgerReleaseHandler(commerce),
    [LEDGER_CHECK_JOB]: createLedgerCheckHandler(commerce),
    [EXPORT_JOB]: createExportHandler({
      prisma,
      storage: media.storage,
      box,
      schoolUrlTemplate: env.SCHOOL_URL_TEMPLATE,
    }),
    [USAGE_METER_JOB]: createUsageMeterHandler({ prisma, box }),
    [PURGE_JOB]: createPurgeHandler({ prisma, storage: media.storage }),
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
  // System side of W6: discovers schools through due_ledger_checks() (ids only), one job per school.
  const sweepLedgers = (): void => {
    enqueueDueLedgerChecks({ prisma, boss }).catch((error: unknown) =>
      logger.error({ err: error }, 'Ledger check sweep failed'),
    );
  };
  sweepLedgers();
  const ledgerTimer = setInterval(sweepLedgers, LEDGER_CHECK_INTERVAL_MS);
  // M9: usage metering (F47) and offboarding purges (F46), discovered hourly in the console realm.
  const sweepSchools = (): void => {
    sweepTenants({ prisma, boss }).catch((error: unknown) =>
      logger.error({ err: error }, 'School sweep failed'),
    );
  };
  sweepSchools();
  const schoolTimer = setInterval(sweepSchools, LEDGER_CHECK_INTERVAL_MS);
  logger.info('Worker started');

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(outboxTimer);
    clearInterval(ledgerTimer);
    clearInterval(schoolTimer);
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
