import { Module } from '@nestjs/common';

import { AuditModule } from '../audit';
import {
  CatalogueController,
  ContentAdminController,
  InstructorController,
  StudioController,
} from './api/courses.controller';
import { CatalogueService } from './application/catalogue.service';
import { CategoriesService } from './application/categories.service';
import { CoursesAdminService } from './application/courses-admin.service';
import { InstructorsService } from './application/instructors.service';
import { StudioService } from './application/studio.service';

/** Catalogue and authoring (M5): categories, instructors, courses, outline, review, public catalogue. */
@Module({
  imports: [AuditModule],
  controllers: [CatalogueController, InstructorController, StudioController, ContentAdminController],
  providers: [CategoriesService, InstructorsService, StudioService, CoursesAdminService, CatalogueService],
})
export class CoursesModule {}
