import { Module } from '@nestjs/common';

import { AuditModule } from '../audit';
import { CommonPasswordChecker } from '../platform';
import { TenancyModule } from '../tenancy';
import { AuthController } from './api/auth.controller';
import { AuthService, BREACHED_PASSWORD_CHECKER } from './application/auth.service';
import { SessionService } from './application/sessions';
import { TeamService } from './application/team.service';

/** Tenant-realm identity (M4): global accounts, school memberships, sessions, invitations, hand-offs. */
@Module({
  imports: [AuditModule, TenancyModule],
  controllers: [AuthController],
  providers: [
    SessionService,
    AuthService,
    TeamService,
    { provide: BREACHED_PASSWORD_CHECKER, useClass: CommonPasswordChecker },
  ],
  exports: [SessionService],
})
export class IdentityModule {}
