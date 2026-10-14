import { Module } from '@nestjs/common';

import { AuditModule } from '../audit';
import { MediaModule } from '../media';
import { EnrollmentsController, LearningController } from './api/learning.controller';
import { EnrollmentsService } from './application/enrollments.service';
import { LearningService } from './application/learning.service';

/** Learning (M6): enrolments and entitlements, the course player, progress and My learning. */
@Module({
  imports: [AuditModule, MediaModule],
  controllers: [LearningController, EnrollmentsController],
  providers: [LearningService, EnrollmentsService],
  exports: [EnrollmentsService],
})
export class LearningModule {}
