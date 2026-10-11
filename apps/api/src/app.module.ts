import { type DynamicModule, Module, type Type } from '@nestjs/common';

import { PlatformModule, type PlatformModuleOptions } from './modules/platform';

export interface AppModuleOptions extends PlatformModuleOptions {
  /** Extra modules (used by integration tests to mount test-only controllers). */
  imports?: Array<Type<unknown> | DynamicModule>;
}

/** Root module. Feature modules are added here from M2 onward. */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.register({ env: options.env, logger: options.logger }),
        ...(options.imports ?? []),
      ],
    };
  }
}
