import { Controller, Get, Header } from '@nestjs/common';
import type { HealthzResponse, ReadyzResponse } from '@studyhub/contracts';

import { ConfigService } from '../config/config.service';
import { PrismaService } from '../db/prisma.service';
import { AppError } from '../errors/app-error';

/** Operational probes (blueprint 04 §12). Never cached; never expose internals. */
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: ConfigService,
    private readonly database: PrismaService,
  ) {}

  /** Liveness: the process is running. Does not touch dependencies. */
  @Get('healthz')
  @Header('Cache-Control', 'no-store')
  healthz(): HealthzResponse {
    return {
      status: 'ok',
      service: 'studyhub-api',
      version: this.config.get('APP_VERSION'),
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  /** Readiness: the database is reachable within READINESS_TIMEOUT_MS. */
  @Get('readyz')
  @Header('Cache-Control', 'no-store')
  async readyz(): Promise<ReadyzResponse> {
    const reachable = await this.database.isReachable(this.config.get('READINESS_TIMEOUT_MS'));
    if (!reachable) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'The database is unreachable.',
        extensions: { checks: { database: 'unavailable' } },
      });
    }
    return { status: 'ok', version: this.config.get('APP_VERSION'), checks: { database: 'ok' } };
  }
}
