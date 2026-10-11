import { Module } from '@nestjs/common';

import { TenantController } from './api/tenant.controller';
import { TenantResolver } from './application/tenant-resolver';
import { TenantRepository } from './infra/tenant.repository';

/** Tenancy kernel: host → school resolution, tenant context, school bootstrap (M2). */
@Module({
  controllers: [TenantController],
  providers: [
    TenantRepository,
    {
      provide: TenantResolver,
      inject: [TenantRepository],
      useFactory: (repository: TenantRepository) => new TenantResolver(repository),
    },
  ],
  exports: [TenantResolver],
})
export class TenancyModule {}
