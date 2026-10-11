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
} from './modules/platform';
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
    { logger: new PinoNestLogger(logger), abortOnError: false },
  );

  const fastify = app.getHttpAdapter().getInstance();
  registerRequestIdHook(fastify);
  registerRequestContextHook(fastify);
  registerTenantContextHook(fastify, app.get(TenantResolver));
  app.useGlobalFilters(new ProblemFilter(logger));
  app.enableShutdownHooks();
  await app.init();
  return app;
}

async function bootstrap(): Promise<void> {
  const env = loadApiEnv();
  const app = await createApp({ env });
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
}

// Guarded so tests can import createApp() without starting a server.
if (typeof require !== 'undefined' && require.main === module) {
  bootstrap().catch((error: unknown) => {
    const message = error instanceof ConfigError ? error.message : `API failed to start: ${String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
