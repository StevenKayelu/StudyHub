import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import {
  ERROR_DEFINITIONS,
  type ErrorCode,
  type Problem,
  PROBLEM_CONTENT_TYPE,
  problemTypeFor,
} from '@studyhub/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import { AppError } from './app-error';

interface ResolvedProblem {
  code: ErrorCode;
  status: number;
  detail?: string;
  errors?: Problem['errors'];
  extensions?: Record<string, unknown>;
}

function statusOf(exception: unknown): number | undefined {
  if (exception instanceof HttpException) return exception.getStatus();
  if (typeof exception === 'object' && exception !== null && 'statusCode' in exception) {
    const status = (exception as { statusCode: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 600) return status;
  }
  return undefined;
}

function resolve(exception: unknown): ResolvedProblem {
  if (exception instanceof AppError) {
    return {
      code: exception.code,
      status: exception.status,
      ...(exception.detail !== undefined && { detail: exception.detail }),
      ...(exception.errors !== undefined && { errors: exception.errors }),
      ...(exception.extensions !== undefined && { extensions: exception.extensions }),
    };
  }
  const status = statusOf(exception);
  if (status === 404) return { code: 'NOT_FOUND', status };
  if (status === 429) return { code: 'RATE_LIMITED', status };
  if (status === 503) return { code: 'SERVICE_UNAVAILABLE', status };
  if (status !== undefined && status >= 400 && status < 500) {
    // Framework-level client errors (malformed JSON, unsupported media type, ...).
    return { code: 'VALIDATION_FAILED', status, detail: 'The request could not be processed as sent.' };
  }
  return { code: 'INTERNAL', status: ERROR_DEFINITIONS.INTERNAL.status };
}

/**
 * Renders every error as RFC 9457 problem+json with a stable `code` and the `requestId`.
 * Unexpected errors are logged with their stack; the client gets a generic message only.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = resolve(exception);

    if (problem.status >= 500 && problem.code === 'INTERNAL') {
      this.logger.error({ err: exception, requestId: request.id }, 'Unhandled error');
    } else {
      this.logger.debug({ requestId: request.id, code: problem.code }, 'Request failed');
    }

    const body: Problem = {
      ...problem.extensions,
      type: problemTypeFor(problem.code),
      title: ERROR_DEFINITIONS[problem.code].title,
      status: problem.status,
      code: problem.code,
      requestId: request.id,
      ...(problem.detail !== undefined && { detail: problem.detail }),
      ...(problem.errors !== undefined && { errors: problem.errors }),
    };

    void reply.status(problem.status).header('Content-Type', PROBLEM_CONTENT_TYPE).send(body);
  }
}
