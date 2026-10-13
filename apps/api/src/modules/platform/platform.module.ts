import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger } from 'pino';

import { API_ENV, ConfigService } from './config/config.service';
import type { ApiEnv } from './config/env.schema';
import { PrismaService } from './db/prisma.service';
import { TenantDb } from './db/tenant-db';
import { HealthController } from './health/health.controller';
import { APP_LOGGER } from './logging/logger';
import { RateLimiter } from './security/rate-limiter';
import { SecretBox } from './security/secret-box';

export interface PlatformModuleOptions {
  env: ApiEnv;
  logger: Logger;
}

/** Shared kernel: configuration, logging, database access, secrets at rest, rate limits, probes. */
@Module({})
export class PlatformModule {
  static register(options: PlatformModuleOptions): DynamicModule {
    return {
      module: PlatformModule,
      global: true,
      controllers: [HealthController],
      providers: [
        { provide: API_ENV, useValue: options.env },
        { provide: APP_LOGGER, useValue: options.logger },
        ConfigService,
        PrismaService,
        TenantDb,
        { provide: SecretBox, useValue: new SecretBox(options.env.IDENTITY_ENCRYPTION_KEY) },
        { provide: RateLimiter, useValue: new RateLimiter() },
      ],
      exports: [ConfigService, PrismaService, TenantDb, APP_LOGGER, SecretBox, RateLimiter],
    };
  }
}
