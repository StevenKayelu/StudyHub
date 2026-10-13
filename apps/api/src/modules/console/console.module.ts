import { Module } from '@nestjs/common';

import { ConsoleController } from './api/console.controller';
import { ConsoleAuthService } from './application/console-auth.service';

/** Platform (console) realm (M4): staff sign-in with mandatory TOTP, re-authentication, staff list. */
@Module({
  controllers: [ConsoleController],
  providers: [ConsoleAuthService],
  exports: [ConsoleAuthService],
})
export class ConsoleModule {}
