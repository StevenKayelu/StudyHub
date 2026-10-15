import { Module } from '@nestjs/common';

import { AuditModule } from '../audit';
import { LearnAssessmentController, StudioAssessmentController } from './api/assessment.controller';
import { AttemptsService } from './application/attempts.service';
import { BankService } from './application/bank.service';
import { PracticeService } from './application/practice.service';
import { QuizzesService } from './application/quizzes.service';
import { ResultsService } from './application/results.service';

/** Assessment (M7): question bank, quizzes, attempts, grading, practice and analytics. */
@Module({
  imports: [AuditModule],
  controllers: [StudioAssessmentController, LearnAssessmentController],
  providers: [BankService, QuizzesService, AttemptsService, PracticeService, ResultsService],
})
export class AssessmentModule {}
