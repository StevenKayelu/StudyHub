import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { Logger } from 'pino';

import { PrismaClient } from '../../../generated/prisma/client';
import { API_ENV } from '../config/config.service';
import type { ApiEnv } from '../config/env.schema';
import { APP_LOGGER } from '../logging/logger';

/**
 * Prisma client connected as the least-privilege `studyhub_app` role through the pg driver adapter.
 * Connections are lazy: the API starts even when the database is down, and /readyz reports it.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(@Inject(API_ENV) env: ApiEnv, @Inject(APP_LOGGER) logger: Logger) {
    const pool = new Pool({
      connectionString: env.DATABASE_URL_APP,
      connectionTimeoutMillis: env.READINESS_TIMEOUT_MS,
      max: 10,
      application_name: 'studyhub-api',
    });
    // Without a listener, an idle connection dropped by the server would crash the process.
    pool.on('error', (error) => logger.warn({ err: error }, 'Idle database connection error'));
    super({ adapter: new PrismaPg(pool) });
    this.pool = pool;
  }

  /** True when `SELECT 1` succeeds within `timeoutMs`. Never throws. */
  async isReachable(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('readiness check timed out')), timeoutMs);
    });
    try {
      await Promise.race([this.$queryRaw`SELECT 1`, timeout]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end().catch(() => undefined);
  }
}
