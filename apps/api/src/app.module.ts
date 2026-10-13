import { type DynamicModule, Module, type Type } from '@nestjs/common';

import { AuditModule } from './modules/audit';
import { ConsoleModule } from './modules/console';
import { IdentityModule } from './modules/identity';
import { PlatformModule, type PlatformModuleOptions } from './modules/platform';
import { TenancyModule } from './modules/tenancy';

export interface AppModuleOptions extends PlatformModuleOptions {
  /** Extra modules (used by integration tests to mount test-only controllers). */
  imports?: Array<Type<unknown> | DynamicModule>;
}

/** Root module: platform kernel, tenancy kernel (M2), audit, identity realms (M4). */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.register({ env: options.env, logger: options.logger }),
        TenancyModule,
        AuditModule,
        IdentityModule,
        ConsoleModule,
        ...(options.imports ?? []),
      ],
    };
  }
}
