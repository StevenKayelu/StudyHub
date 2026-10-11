import { Controller, Get, Header } from '@nestjs/common';
import type { TenantBootstrap } from '@studyhub/contracts';

import { AppError, requireTenantId, TenantDb } from '../../platform';
import { TenantRepository } from '../infra/tenant.repository';

@Controller('api/v1/tenant')
export class TenantController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly tenants: TenantRepository,
  ) {}

  /** The school resolved from the request host (blueprint 05 §8.3; branding etc. arrive later). */
  @Get()
  @Header('Cache-Control', 'no-store')
  async bootstrap(): Promise<TenantBootstrap> {
    const tenantId = requireTenantId();
    const tenant = await this.tenantDb.run((tx) => this.tenants.findBootstrap(tx, tenantId));
    if (tenant === null) throw new AppError('TENANT_NOT_FOUND');
    return tenant;
  }
}
