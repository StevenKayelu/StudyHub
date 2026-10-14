import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { grantEnrollmentSchema, progressUpdateSchema, revokeEnrollmentSchema } from '@studyhub/contracts';

import { z } from 'zod';

import { currentActor, type TenantActor } from '../../identity';
import { AppError, parseOrThrow } from '../../platform';
import { EnrollmentsService } from '../application/enrollments.service';
import { LearningService } from '../application/learning.service';

function requireActor(): TenantActor {
  const actor = currentActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

const uuid = () => new ParseUUIDPipe();

/** Learning (05 §4.6): enrolment, the course player, progress and My learning (F14–F16). */
@Controller('api/v1')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  /** By slug, like the landing page it is offered on (the two routes share the `:slug` segment). */
  @Post('courses/:slug/enrol')
  @HttpCode(200)
  enrol(@Param('slug') slug: string) {
    return this.learning.enrol(currentActor(), parseOrThrow(z.string().max(100), slug));
  }

  @Get('me/enrollments')
  @Header('Cache-Control', 'private, no-store')
  myLearning() {
    return this.learning.myLearning(currentActor());
  }

  @Get('learn/courses/:id')
  @Header('Cache-Control', 'private, no-store')
  course(@Param('id', uuid()) id: string) {
    return this.learning.course(currentActor(), id);
  }

  @Get('learn/lessons/:id')
  @Header('Cache-Control', 'private, no-store')
  lesson(@Param('id', uuid()) id: string) {
    return this.learning.lesson(currentActor(), id);
  }

  @Get('learn/lessons/:id/playback')
  @Header('Cache-Control', 'private, no-store')
  playback(@Param('id', uuid()) id: string) {
    return this.learning.playback(currentActor(), id);
  }

  @Get('learn/lessons/:id/files/:assetId/url')
  @Header('Cache-Control', 'private, no-store')
  fileUrl(@Param('id', uuid()) id: string, @Param('assetId', uuid()) assetId: string) {
    return this.learning.fileUrl(currentActor(), id, assetId);
  }

  @Put('learn/lessons/:id/progress')
  saveProgress(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.learning.saveProgress(actor, id, parseOrThrow(progressUpdateSchema, body));
  }
}

/** Enrolments seen from the course: Studio learners (S-T09) and administrators' grants (F14). */
@Controller('api/v1')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Get('studio/courses/:id/learners')
  @Header('Cache-Control', 'private, no-store')
  learners(@Param('id', uuid()) id: string) {
    return this.enrollments.learners(requireActor(), id);
  }

  @Get('admin/courses/:id/enrollments')
  @Header('Cache-Control', 'private, no-store')
  forAdmin(@Param('id', uuid()) id: string) {
    return this.enrollments.forAdmin(requireActor(), id);
  }

  @Post('admin/courses/:id/enrollments')
  @HttpCode(201)
  grant(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.enrollments.grant(actor, id, parseOrThrow(grantEnrollmentSchema, body));
  }

  @Post('admin/enrollments/:id/revoke')
  @HttpCode(204)
  async revoke(@Param('id', uuid()) id: string, @Body() body: unknown): Promise<void> {
    const actor = requireActor();
    await this.enrollments.revoke(actor, id, parseOrThrow(revokeEnrollmentSchema, body).reason);
  }
}
