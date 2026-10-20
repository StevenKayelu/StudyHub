import { Module } from '@nestjs/common';

import { ConfigurationModule } from '../configuration';
import { TenancyModule } from '../tenancy';
import { ConsoleConfigurationController } from './api/console-configuration.controller';
import { ConsoleAdminController } from './api/console-admin.controller';
import { ConsoleController } from './api/console.controller';
import { ConsoleAuthService } from './application/console-auth.service';
import { ConsoleBillingService } from './application/console-billing.service';
import { ConsolePlatformService } from './application/console-platform.service';
import { ConsoleSupportService } from './application/console-support.service';
import { ConsoleTenantsService } from './application/console-tenants.service';

/**
 * Platform (console) realm: staff sign-in with mandatory TOTP and re-authentication (M4); schools,
 * plans, staff, global settings, audit, domain approvals, statements and support access (M9, F43).
 */
@Module({
  imports: [TenancyModule, ConfigurationModule],
  controllers: [ConsoleController, ConsoleAdminController, ConsoleConfigurationController],
  providers: [
    ConsoleAuthService,
    ConsoleTenantsService,
    ConsolePlatformService,
    ConsoleBillingService,
    ConsoleSupportService,
  ],
  exports: [ConsoleAuthService],
})
export class ConsoleModule {}
