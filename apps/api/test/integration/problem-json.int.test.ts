import { Writable } from 'node:stream';

import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PROBLEM_CONTENT_TYPE, problemSchema, problemTypeFor } from '@studyhub/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from '../../src/main';
import { createLogger, loadApiEnv, parseOrThrow } from '../../src/modules/platform';

const LEAKY_MESSAGE = 'connection failed for password=hunter2-should-never-leak';

const demoInputSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
});

/** Test-only routes, mounted only in this test (never part of the production app). */
@Controller('__test')
class ProblemDemoController {
  @Post('validate')
  validate(@Body() body: unknown) {
    return parseOrThrow(demoInputSchema, body);
  }

  @Get('boom')
  boom(): never {
    throw new Error(LEAKY_MESSAGE);
  }
}

@Module({ controllers: [ProblemDemoController] })
class ProblemDemoModule {}

describe('problem+json error contract', () => {
  let app: NestFastifyApplication;
  const logLines: string[] = [];

  beforeAll(async () => {
    // No database is needed: the Prisma client connects lazily and these routes never query it.
    const env = loadApiEnv({
      DATABASE_URL_APP: 'postgresql://studyhub_app:unused@127.0.0.1:1/unused',
      LOG_LEVEL: 'info',
    });
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logLines.push(chunk.toString('utf8'));
        callback();
      },
    });
    app = await createApp({
      env,
      logger: createLogger({ level: 'info', destination }),
      imports: [ProblemDemoModule],
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('unknown route → 404 NOT_FOUND problem with requestId matching the header', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const problem = problemSchema.parse(response.json());
    expect(problem).toMatchObject({ status: 404, code: 'NOT_FOUND', type: problemTypeFor('NOT_FOUND') });
    expect(problem.requestId).toBe(response.headers['x-request-id']);
  });

  it('invalid input → 422 VALIDATION_FAILED with field errors', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/__test/validate',
      payload: { name: '', age: -3 },
    });
    expect(response.statusCode).toBe(422);
    const problem = problemSchema.parse(response.json());
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.map((error) => error.field).sort()).toEqual(['age', 'name']);
  });

  it('valid input passes validation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/__test/validate',
      payload: { name: 'Ada', age: 30 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ name: 'Ada', age: 30 });
  });

  it('malformed JSON → 400 VALIDATION_FAILED problem', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/__test/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(problemSchema.parse(response.json()).code).toBe('VALIDATION_FAILED');
  });

  it('unexpected exception → 500 INTERNAL without stack trace or internal message', async () => {
    const response = await app.inject({ method: 'GET', url: '/__test/boom' });
    expect(response.statusCode).toBe(500);
    const problem = problemSchema.parse(response.json());
    expect(problem.code).toBe('INTERNAL');
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toMatch(/at .+\.(ts|js):\d+/);
    expect(response.body).not.toContain('stack');

    // The stack goes to the logs instead, correlated by requestId.
    const errorLog = logLines.find((line) => line.includes('Unhandled error'));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain(problem.requestId);
  });

  it('echoes a valid incoming X-Request-Id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
      headers: { 'x-request-id': 'client-request-0001' },
    });
    expect(response.headers['x-request-id']).toBe('client-request-0001');
    expect(problemSchema.parse(response.json()).requestId).toBe('client-request-0001');
  });

  it('replaces an unsafe incoming X-Request-Id with a generated one', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
      headers: { 'x-request-id': 'bad id <script>' },
    });
    expect(response.headers['x-request-id']).toMatch(/^req_[0-9a-f-]{36}$/);
  });
});
