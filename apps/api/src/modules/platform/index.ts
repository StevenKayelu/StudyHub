// Public surface of the platform (shared kernel) module. Other modules and entry points import
// only from here (enforced by dependency-cruiser).
export { API_ENV, ConfigService } from './config/config.service';
export { type ApiEnv, ConfigError, loadApiEnv, loadMigratorEnv, type MigratorEnv } from './config/env.schema';
export { PrismaService } from './db/prisma.service';
export { AppError, parseOrThrow, zodIssuesToFieldErrors } from './errors/app-error';
export { ProblemFilter } from './errors/problem.filter';
export {
  createRuntimeBoss,
  DEFAULT_JOB_HANDLERS,
  enqueue,
  installJobSchema,
  JOB_SCHEMA,
  type JobHandler,
  QUEUE_DEFINITIONS,
  startWorker,
} from './jobs/boss';
export { HEARTBEAT_JOB } from './jobs/heartbeat.job';
export { createEnvelope, type JobEnvelope, jobEnvelopeSchema } from './jobs/job-envelope';
export { APP_LOGGER, createLogger, PinoNestLogger } from './logging/logger';
export { genReqId, registerRequestIdHook, REQUEST_ID_HEADER } from './logging/request-id.hook';
export { PlatformModule, type PlatformModuleOptions } from './platform.module';
