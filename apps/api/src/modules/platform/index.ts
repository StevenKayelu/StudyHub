// Public surface of the platform (shared kernel) module. Other modules and entry points import
// only from here (enforced by dependency-cruiser).
export { API_ENV, ConfigService } from './config/config.service';
export {
  type ApiEnv,
  ConfigError,
  DEV_IDENTITY_ENCRYPTION_KEY,
  loadApiEnv,
  loadMigratorEnv,
  type MigratorEnv,
} from './config/env.schema';
export { tenantCacheKey } from './cache/cache-key';
export {
  currentContext,
  registerRequestContextHook,
  type RequestContext,
  requireTenantId,
  runWithContext,
} from './context/request-context';
export { PrismaService } from './db/prisma.service';
export { runInPlatformTx, runInTenantTx, TenantDb, type TenantTx } from './db/tenant-db';
export { AppError, parseOrThrow, zodIssuesToFieldErrors } from './errors/app-error';
export { buildProblem, ProblemFilter, sendProblem } from './errors/problem.filter';
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
export {
  createEnvelope,
  type EnvelopeOptions,
  type JobEnvelope,
  jobEnvelopeSchema,
  SYSTEM_JOB_PREFIX,
} from './jobs/job-envelope';
export { addToOutbox, dispatchDueOutbox } from './jobs/outbox';
export { APP_LOGGER, createLogger, PinoNestLogger } from './logging/logger';
export {
  createEmailHandler,
  createMailTransport,
  EMAIL_SEND_JOB,
  emailPayloadSchema,
  queueEmail,
} from './mail/email.job';
export { type EmailTemplate, type EmailVariables, renderEmail } from './mail/templates';
export {
  type BreachedPasswordChecker,
  CommonPasswordChecker,
  decoyPasswordHash,
  hashPassword,
  hashRecoveryCode,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  type PasswordProblem,
  verifyPassword,
} from './security/passwords';
export { RATE_RULES, RateLimiter, type RateRule } from './security/rate-limiter';
export { SecretBox } from './security/secret-box';
export {
  hashToken,
  type IssuedToken,
  issueToken,
  isWellFormedToken,
  safeEqual,
  toBytes,
} from './security/tokens';
export {
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  timeStep,
  totpCode,
  verifyTotp,
} from './security/totp';
export { genReqId, registerRequestIdHook, REQUEST_ID_HEADER } from './logging/request-id.hook';
export { PlatformModule, type PlatformModuleOptions } from './platform.module';
