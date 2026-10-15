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
  Res,
} from '@nestjs/common';
import {
  answerResponseSchema,
  createQuizSchema,
  gradeItemSchema,
  practiceStartSchema,
  questionInputSchema,
  questionListQuerySchema,
  questionUpdateSchema,
  quizItemsSchema,
  saveAnswerSchema,
  studioAttemptsQuerySchema,
  updateQuizSchema,
} from '@studyhub/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { currentActor, type TenantActor } from '../../identity';
import { AppError, parseOrThrow } from '../../platform';
import { AttemptsService } from '../application/attempts.service';
import { BankService } from '../application/bank.service';
import { PracticeService } from '../application/practice.service';
import { QuizzesService } from '../application/quizzes.service';
import { ResultsService } from '../application/results.service';

function requireActor(): TenantActor {
  const actor = currentActor();
  if (actor === null) throw new AppError('UNAUTHENTICATED');
  return actor;
}

const uuid = () => new ParseUUIDPipe();

/** Studio: question bank, quizzes, results, grading and analytics (05 §4.4; F17, F18, F20, F21, F23). */
@Controller('api/v1/studio')
export class StudioAssessmentController {
  constructor(
    private readonly bank: BankService,
    private readonly quizzes: QuizzesService,
    private readonly results: ResultsService,
    private readonly attempts: AttemptsService,
  ) {}

  @Get('courses/:id/questions')
  @Header('Cache-Control', 'private, no-store')
  questions(@Param('id', uuid()) id: string, @Query() query: Record<string, unknown>) {
    return this.bank.list(requireActor(), id, parseOrThrow(questionListQuerySchema, query));
  }

  @Post('courses/:id/questions')
  @HttpCode(201)
  createQuestion(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.bank.create(actor, id, parseOrThrow(questionInputSchema, body));
  }

  @Get('questions/:id')
  @Header('Cache-Control', 'private, no-store')
  question(@Param('id', uuid()) id: string) {
    return this.bank.get(requireActor(), id);
  }

  @Patch('questions/:id')
  updateQuestion(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.bank.update(actor, id, parseOrThrow(questionUpdateSchema, body));
  }

  /** Archives (questions are never deleted: attempts keep their snapshots, F17 AC 3). */
  @Delete('questions/:id')
  @HttpCode(204)
  async archiveQuestion(@Param('id', uuid()) id: string): Promise<void> {
    await this.bank.archive(requireActor(), id);
  }

  @Post('questions/:id/duplicate')
  @HttpCode(201)
  duplicate(@Param('id', uuid()) id: string) {
    return this.bank.duplicate(requireActor(), id);
  }

  @Get('courses/:id/quizzes')
  @Header('Cache-Control', 'private, no-store')
  quizList(@Param('id', uuid()) id: string) {
    return this.quizzes.list(requireActor(), id);
  }

  @Post('courses/:id/quizzes')
  @HttpCode(201)
  createQuiz(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.quizzes.create(actor, id, parseOrThrow(createQuizSchema, body).title);
  }

  @Get('quizzes/:id')
  @Header('Cache-Control', 'private, no-store')
  quiz(@Param('id', uuid()) id: string) {
    return this.quizzes.get(requireActor(), id);
  }

  @Patch('quizzes/:id')
  updateQuiz(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.quizzes.update(actor, id, parseOrThrow(updateQuizSchema, body));
  }

  @Put('quizzes/:id/items')
  setItems(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.quizzes.setItems(actor, id, parseOrThrow(quizItemsSchema, body));
  }

  @Delete('quizzes/:id')
  @HttpCode(204)
  async deleteQuiz(@Param('id', uuid()) id: string): Promise<void> {
    await this.quizzes.remove(requireActor(), id);
  }

  @Get('quizzes/:id/analytics')
  @Header('Cache-Control', 'private, no-store')
  analytics(@Param('id', uuid()) id: string) {
    return this.results.analytics(requireActor(), id);
  }

  @Get('courses/:id/attempts')
  @Header('Cache-Control', 'private, no-store')
  courseAttempts(@Param('id', uuid()) id: string, @Query() query: Record<string, unknown>) {
    return this.results.attempts(requireActor(), id, parseOrThrow(studioAttemptsQuerySchema, query));
  }

  @Get('courses/:id/grading-queue')
  @Header('Cache-Control', 'private, no-store')
  gradingQueue(@Param('id', uuid()) id: string) {
    return this.results.queue(requireActor(), id);
  }

  @Get('attempts/:id')
  @Header('Cache-Control', 'private, no-store')
  attempt(@Param('id', uuid()) id: string) {
    return this.attempts.result(requireActor(), id);
  }

  @Put('attempts/:id/items/:itemId/grade')
  grade(@Param('id', uuid()) id: string, @Param('itemId', uuid()) itemId: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.results.grade(actor, id, itemId, parseOrThrow(gradeItemSchema, body));
  }
}

/** Learner assessment (05 §4.7): quizzes, attempts, results and practice (F19–F22). */
@Controller('api/v1')
export class LearnAssessmentController {
  constructor(
    private readonly attempts: AttemptsService,
    private readonly practice: PracticeService,
  ) {}

  @Get('learn/quizzes/:id')
  @Header('Cache-Control', 'private, no-store')
  intro(@Param('id', uuid()) id: string) {
    return this.attempts.intro(currentActor(), id);
  }

  /** Start, or return the attempt already in progress (201 new, 200 existing; F19 AC 5). */
  @Post('learn/quizzes/:id/attempts')
  async start(@Param('id', uuid()) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const { created, view } = await this.attempts.start(currentActor(), id);
    void reply.status(created ? 201 : 200);
    return view;
  }

  @Get('learn/quizzes/:id/attempts')
  @Header('Cache-Control', 'private, no-store')
  history(@Param('id', uuid()) id: string) {
    return this.attempts.history(currentActor(), id);
  }

  @Get('learn/attempts/:id')
  @Header('Cache-Control', 'private, no-store')
  view(@Param('id', uuid()) id: string) {
    return this.attempts.view(currentActor(), id);
  }

  @Put('learn/attempts/:id/answers/:itemId')
  saveAnswer(
    @Param('id', uuid()) id: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() body: unknown,
  ) {
    const actor = requireActor();
    return this.attempts.saveAnswer(actor, id, itemId, parseOrThrow(saveAnswerSchema, body));
  }

  @Post('learn/attempts/:id/submit')
  @HttpCode(200)
  submit(@Param('id', uuid()) id: string) {
    return this.attempts.submit(currentActor(), id);
  }

  @Get('learn/attempts/:id/result')
  @Header('Cache-Control', 'private, no-store')
  result(@Param('id', uuid()) id: string) {
    return this.attempts.result(currentActor(), id);
  }

  @Get('me/assessments')
  @Header('Cache-Control', 'private, no-store')
  mine() {
    return this.attempts.mine(currentActor());
  }

  @Get('learn/courses/:id/practice')
  @Header('Cache-Control', 'private, no-store')
  practiceSetup(@Param('id', uuid()) id: string) {
    return this.practice.setup(currentActor(), id);
  }

  @Post('learn/courses/:id/practice')
  @HttpCode(201)
  startPractice(@Param('id', uuid()) id: string, @Body() body: unknown) {
    const actor = requireActor();
    return this.practice.start(actor, id, parseOrThrow(practiceStartSchema, body ?? {}));
  }

  @Put('learn/practice/:attemptId/answers/:itemId')
  practiceAnswer(
    @Param('attemptId', uuid()) attemptId: string,
    @Param('itemId', uuid()) itemId: string,
    @Body() body: unknown,
  ) {
    const actor = requireActor();
    const { response } = parseOrThrow(z.object({ response: answerResponseSchema }), body);
    return this.practice.answer(actor, attemptId, itemId, response);
  }

  @Post('learn/practice/:attemptId/finish')
  @HttpCode(200)
  finishPractice(@Param('attemptId', uuid()) attemptId: string) {
    return this.practice.finish(currentActor(), attemptId);
  }
}
