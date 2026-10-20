import 'reflect-metadata';

import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { LogController } from 'fastify';
import type { Logger } from 'pino';

import { AppModule } from './app.module';
import {
  type ApiEnv,
  ConfigError,
  createLogger,
  genReqId,
  loadApiEnv,
  PinoNestLogger,
  ProblemFilter,
  registerRequestContextHook,
  registerRequestIdHook,
  registerClientRateLimitHook,
  registerTenantRateLimitHook,
  registerSecurityHeadersHook,
  STORAGE_LOCATIONS,
  type StorageLocations,
} from './modules/platform';
import { ConsoleAuthService, registerConsoleHook } from './modules/console';
import {
  registerOriginCheckHook,
  registerSessionHook,
  SessionService,
  SupportSessionService,
} from './modules/identity';
import { registerTenantContextHook, TenantResolver } from './modules/tenancy';

/** JSON bodies above 1 MB are rejected; uploads never pass through the API (blueprint 04 §7.4). */
const BODY_LIMIT_BYTES = 1_048_576;

export interface CreateAppOptions {
  env: ApiEnv;
  logger?: Logger;
  imports?: Array<Type<unknown> | DynamicModule>;
}

/** Builds and initialises the HTTP application without listening (used by tests and bootstrap). */
export async function createApp(options: CreateAppOptions): Promise<NestFastifyApplication> {
  const logger = options.logger ?? createLogger({ level: options.env.LOG_LEVEL });
  const adapter = new FastifyAdapter({
    loggerInstance: logger,
    genReqId,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    bodyLimit: BODY_LIMIT_BYTES,
    // X-Forwarded-* are honoured only from these addresses (reverse proxy, web server): threat T3.
    trustProxy: options.env.TRUSTED_PROXIES,
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({ env: options.env, logger, ...(options.imports && { imports: options.imports }) }),
    adapter,
    // rawBody: provider webhooks verify signatures over the exact bytes received.
    { logger: new PinoNestLogger(logger), abortOnError: false, rawBody: true },
  );

  const fastify = app.getHttpAdapter().getInstance();
  // Video bytes (the fake provider's development upload) are drained, never buffered in memory.
  fastify.addContentTypeParser(/^video\//, (_request, payload, done) => {
    payload.on('error', done);
    payload.on('end', () => done(null, undefined));
    payload.resume();
  });
  registerRequestIdHook(fastify);
  registerSecurityHeadersHook(fastify, options.env.NODE_ENV === 'production');
  registerRequestContextHook(fastify);
  registerClientRateLimitHook(fastify, options.env);
  // Order matters: CSRF origin check, then the school (from the host), then who is signed in.
  registerOriginCheckHook(fastify);
  registerTenantContextHook(fastify, app.get(TenantResolver));
  registerTenantRateLimitHook(fastify, options.env);
  registerSessionHook(fastify, app.get(SessionService), app.get(SupportSessionService));
  registerConsoleHook(fastify, app.get(ConsoleAuthService), options.env.CONSOLE_HOSTS);
  app.useGlobalFilters(new ProblemFilter(logger));
  app.enableShutdownHooks();
  await app.init();
  return app;
}

async function bootstrap(): Promise<void> {
  const env = loadApiEnv();
  const logger = createLogger({ level: env.LOG_LEVEL });
  const app = await createApp({ env, logger });
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  await warnIfStorageNotCaptured(app.get<StorageLocations>(STORAGE_LOCATIONS), logger);
}

/**
 * Storage fails closed until the deployment's origin is captured, so say so loudly at startup rather
 * than through the first upload's 503. Capture stays an explicit operator step (storage:bootstrap).
 */
async function warnIfStorageNotCaptured(locations: StorageLocations, logger: Logger): Promise<void> {
  try {
    if (await locations.activeCaptured()) return;
    logger.error(
      'Object storage has not been captured: uploads, exports and downloads return 503. Run `pnpm storage:bootstrap` (see docs/runbooks/staging-readiness.md).',
    );
  } catch {
    // Database unavailable at startup: /readyz reports it.
  }
}

// Guarded so tests can import createApp() without starting a server.
if (typeof require !== 'undefined' && require.main === module) {
  bootstrap().catch((error: unknown) => {
    const message = error instanceof ConfigError ? error.message : `API failed to start: ${String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
