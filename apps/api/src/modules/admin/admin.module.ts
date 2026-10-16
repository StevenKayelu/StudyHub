import { Module } from '@nestjs/common';

import { AuditModule } from '../audit';
import { TenancyModule } from '../tenancy';
import { AdminController, SchoolPublicController } from './api/admin.controller';
import { AuditLogService } from './application/audit-log.service';
import { BrandingService } from './application/branding.service';
import { ExportsService } from './application/exports.service';
import { FeaturesService } from './application/features.service';
import { NotificationsService } from './application/notifications.service';
import { QueuesService } from './application/queues.service';
import { ReportsService } from './application/reports.service';
import { SchoolService } from './application/school.service';
import { SupportAccessService } from './application/support-access.service';
import { UsageService } from './application/usage';
import { UsersService } from './application/users.service';

/** School administration (M9): F30–F35, F39–F42, F44, F46–F49 on the school host. */
@Module({
  imports: [AuditModule, TenancyModule],
  controllers: [AdminController, SchoolPublicController],
  providers: [
    AuditLogService,
    BrandingService,
    ExportsService,
    FeaturesService,
    NotificationsService,
    QueuesService,
    ReportsService,
    SchoolService,
    SupportAccessService,
    UsageService,
    UsersService,
  ],
})
export class AdminModule {}
