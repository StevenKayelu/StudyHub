import { type DynamicModule, Module } from '@nestjs/common';
import type { Logger } from 'pino';

import { API_ENV, ConfigService } from './config/config.service';
import type { ApiEnv } from './config/env.schema';
import { PrismaService } from './db/prisma.service';
import { TenantDb } from './db/tenant-db';
import { HealthController } from './health/health.controller';
import { APP_LOGGER } from './logging/logger';
import { createMediaPorts, MALWARE_SCANNER, OBJECT_STORAGE, VIDEO_PROVIDER } from './media/media-ports';
import { STORAGE_LOCATIONS, StorageLocations } from './media/storage-locations';
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
        ...(() => {
          const ports = createMediaPorts(options.env);
          return [
            { provide: OBJECT_STORAGE, useValue: ports.storage },
            { provide: MALWARE_SCANNER, useValue: ports.scanner },
            { provide: VIDEO_PROVIDER, useValue: ports.video },
          ];
        })(),
        { provide: API_ENV, useValue: options.env },
        { provide: APP_LOGGER, useValue: options.logger },
        ConfigService,
        PrismaService,
        TenantDb,
        {
          provide: STORAGE_LOCATIONS,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService) => new StorageLocations(prisma, options.env),
        },
        { provide: SecretBox, useValue: new SecretBox(options.env.IDENTITY_ENCRYPTION_KEY) },
        { provide: RateLimiter, useValue: new RateLimiter() },
      ],
      exports: [
        ConfigService,
        PrismaService,
        TenantDb,
        APP_LOGGER,
        SecretBox,
        RateLimiter,
        OBJECT_STORAGE,
        STORAGE_LOCATIONS,
        MALWARE_SCANNER,
        VIDEO_PROVIDER,
      ],
    };
  }
}
