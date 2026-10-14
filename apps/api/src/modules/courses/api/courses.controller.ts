import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  catalogueQuerySchema,
  createCategorySchema,
  createCourseSchema,
  createLessonSchema,
  createSectionSchema,
  createSubjectSchema,
  instructorApplicationSchema,
  instructorDecisionSchema,
  reorderOutlineSchema,
  reviewDecisionSchema,
  updateCategorySchema,
  updateCourseSchema,
  updateLessonSchema,
  updateSectionSchema,
} from '@studyhub/contracts';
import { z } from 'zod';

import { can, currentActor, type TenantActor } from '../../identity';
import { AppError, parseOrThrow } from '../../platform';
import { CatalogueService } from '../application/catalogue.service';
import { CategoriesService } from '../application/categories.service';
import { CoursesAdminService } from '../application/courses-admin.service';
import { InstructorsService } from '../application/instructors.service';
import { StudioService } from '../application/studio.service';

function requireActor(): TenantActor {
  const actor = currentActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

const uuid = () => new ParseUUIDPipe();

/** Public catalogue (05 §4.3, F13; BR-57 members-only applies). */
@Controller('api/v1')
export class CatalogueController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly categories: CategoriesService,
  ) {}

  @Get('categories')
  @Header('Cache-Control', 'private, max-age=60')
  categoryTree() {
    return this.categories.tree(false);
  }

  @Get('courses')
  @Header('Cache-Control', 'private, no-store')
  search(@Query() query: Record<string, unknown>) {
    return this.catalogue.search(currentActor(), parseOrThrow(catalogueQuerySchema, query));
  }

  @Get('courses/:slug')
  @Header('Cache-Control', 'private, no-store')
  landing(@Param('slug') slug: string) {
    return this.catalogue.landing(currentActor(), parseOrThrow(z.string().max(100), slug));
  }

  @Get('instructors/:slug')
  @Header('Cache-Control', 'private, no-store')
  instructor(@Param('slug') slug: string) {
    return this.catalogue.instructor(currentActor(), parseOrThrow(z.string().max(80), slug));
  }
}

/** Instructor application and profile (05 §4.2, F06, S-T01, S-T12). */
@Controller('api/v1/me/instructor')
export class InstructorController {
  constructor(private readonly instructors: InstructorsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  mine() {
    return this.instructors.mine(requireActor());
  }

  @Put()
  save(@Body() body: unknown) {
    return this.instructors.save(requireActor(), parseOrThrow(instructorApplicationSchema, body));
  }

  @Post('submit')
  @HttpCode(200)
  submit() {
    return this.instructors.submit(requireActor());
  }
}

/** Studio: authoring by the course owner (05 §4.4). */
@Controller('api/v1/studio/courses')
export class StudioController {
  constructor(private readonly studio: StudioService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list() {
    return this.studio.list(requireActor());
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    return this.studio.create(requireActor(), parseOrThrow(createCourseSchema, body));
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  get(@Param('id', uuid()) id: string) {
    return this.studio.get(requireActor(), id);
  }

  @Patch(':id')
  update(@Param('id', uuid()) id: string, @Body() body: unknown) {
    return this.studio.update(requireActor(), id, parseOrThrow(updateCourseSchema, body));
  }

  @Get(':id/outline')
  @Header('Cache-Control', 'private, no-store')
  outline(@Param('id', uuid()) id: string) {
    return this.studio.outline(requireActor(), id);
  }

  @Put(':id/outline/order')
  reorder(@Param('id', uuid()) id: string, @Body() body: unknown) {
    return this.studio.reorder(requireActor(), id, parseOrThrow(reorderOutlineSchema, body));
  }

  @Post(':id/sections')
  @HttpCode(201)
  addSection(@Param('id', uuid()) id: string, @Body() body: unknown) {
    return this.studio.addSection(requireActor(), id, parseOrThrow(createSectionSchema, body).title);
  }

  @Patch(':id/sections/:sectionId')
  renameSection(
    @Param('id', uuid()) id: string,
    @Param('sectionId', uuid()) sectionId: string,
    @Body() body: unknown,
  ) {
    return this.studio.renameSection(
      requireActor(),
      id,
      sectionId,
      parseOrThrow(updateSectionSchema, body).title,
    );
  }

  @Delete(':id/sections/:sectionId')
  deleteSection(@Param('id', uuid()) id: string, @Param('sectionId', uuid()) sectionId: string) {
    return this.studio.deleteSection(requireActor(), id, sectionId);
  }

  @Post(':id/lessons')
  @HttpCode(201)
  addLesson(@Param('id', uuid()) id: string, @Body() body: unknown) {
    return this.studio.addLesson(requireActor(), id, parseOrThrow(createLessonSchema, body));
  }

  @Get(':id/lessons/:lessonId')
  @Header('Cache-Control', 'private, no-store')
  lesson(@Param('id', uuid()) id: string, @Param('lessonId', uuid()) lessonId: string) {
    return this.studio.lesson(requireActor(), id, lessonId);
  }

  @Patch(':id/lessons/:lessonId')
  updateLesson(
    @Param('id', uuid()) id: string,
    @Param('lessonId', uuid()) lessonId: string,
    @Body() body: unknown,
  ) {
    return this.studio.updateLesson(requireActor(), id, lessonId, parseOrThrow(updateLessonSchema, body));
  }

  @Delete(':id/lessons/:lessonId')
  deleteLesson(@Param('id', uuid()) id: string, @Param('lessonId', uuid()) lessonId: string) {
    return this.studio.deleteLesson(requireActor(), id, lessonId);
  }

  @Get(':id/publish-checklist')
  @Header('Cache-Control', 'private, no-store')
  checklist(@Param('id', uuid()) id: string) {
    return this.studio.checklist(requireActor(), id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(@Param('id', uuid()) id: string) {
    return this.studio.submit(requireActor(), id);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  unpublish(@Param('id', uuid()) id: string) {
    return this.studio.transition(requireActor(), id, 'unpublish');
  }

  @Post(':id/publish')
  @HttpCode(200)
  republish(@Param('id', uuid()) id: string) {
    return this.studio.transition(requireActor(), id, 'republish');
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@Param('id', uuid()) id: string) {
    return this.studio.transition(requireActor(), id, 'archive');
  }
}

/** School administration of the catalogue (05 §4.9: categories, instructors, review, courses). */
@Controller('api/v1/admin')
export class ContentAdminController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly instructors: InstructorsService,
    private readonly courses: CoursesAdminService,
  ) {}

  @Get('categories')
  @Header('Cache-Control', 'private, no-store')
  categoryTree() {
    const actor = requireActor();
    if (!can(actor, 'admin.access')) throw new AppError('FORBIDDEN');
    return this.categories.tree(true);
  }

  @Post('categories')
  @HttpCode(201)
  createCategory(@Body() body: unknown) {
    return this.categories.createCategory(requireActor(), parseOrThrow(createCategorySchema, body));
  }

  @Patch('categories/:id')
  @HttpCode(204)
  async updateCategory(@Param('id', uuid()) id: string, @Body() body: unknown): Promise<void> {
    await this.categories.update(requireActor(), 'category', id, parseOrThrow(updateCategorySchema, body));
  }

  @Post('subjects')
  @HttpCode(201)
  createSubject(@Body() body: unknown) {
    return this.categories.createSubject(requireActor(), parseOrThrow(createSubjectSchema, body));
  }

  @Patch('subjects/:id')
  @HttpCode(204)
  async updateSubject(@Param('id', uuid()) id: string, @Body() body: unknown): Promise<void> {
    await this.categories.update(requireActor(), 'subject', id, parseOrThrow(updateCategorySchema, body));
  }

  @Get('instructor-applications')
  @Header('Cache-Control', 'private, no-store')
  applications() {
    return this.instructors.queue(requireActor());
  }

  @Post('instructors/:membershipId/decision')
  @HttpCode(204)
  async decideInstructor(
    @Param('membershipId', uuid()) membershipId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.instructors.decide(requireActor(), membershipId, parseOrThrow(instructorDecisionSchema, body));
  }

  @Get('course-reviews')
  @Header('Cache-Control', 'private, no-store')
  reviews() {
    return this.courses.reviewQueue(requireActor());
  }

  @Post('courses/:id/review')
  @HttpCode(204)
  async review(@Param('id', uuid()) id: string, @Body() body: unknown): Promise<void> {
    await this.courses.decide(requireActor(), id, parseOrThrow(reviewDecisionSchema, body));
  }

  @Get('courses')
  @Header('Cache-Control', 'private, no-store')
  list(@Query('status') status: unknown) {
    const parsed = parseOrThrow(
      z.enum(['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED']).optional(),
      status,
    );
    return this.courses.courses(requireActor(), parsed);
  }

  @Post('courses/:id/unpublish')
  @HttpCode(204)
  async unpublish(@Param('id', uuid()) id: string, @Body() body: unknown): Promise<void> {
    const { reason } = parseOrThrow(z.object({ reason: z.string().trim().min(1).max(2000) }), body);
    await this.courses.unpublish(requireActor(), id, reason);
  }
}
