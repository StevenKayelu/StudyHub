import { ERROR_DEFINITIONS, type ErrorCode, type ProblemFieldError } from '@studyhub/contracts';
import type { z } from 'zod';

export interface AppErrorOptions {
  detail?: string;
  errors?: ProblemFieldError[];
  /** RFC 9457 extension members (e.g. `checks`). Must never contain secrets or personal data. */
  extensions?: Record<string, unknown>;
  cause?: unknown;
}

/** An expected, client-facing error. Rendered as problem+json by ProblemFilter. */
export class AppError extends Error {
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: ProblemFieldError[] | undefined;
  readonly extensions: Record<string, unknown> | undefined;

  constructor(
    readonly code: ErrorCode,
    options: AppErrorOptions = {},
  ) {
    super(options.detail ?? ERROR_DEFINITIONS[code].title, { cause: options.cause });
    this.name = 'AppError';
    this.status = ERROR_DEFINITIONS[code].status;
    this.detail = options.detail;
    this.errors = options.errors;
    this.extensions = options.extensions;
  }
}

export function zodIssuesToFieldErrors(issues: readonly z.core.$ZodIssue[]): ProblemFieldError[] {
  return issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

/** Validate untrusted input against a contract schema, or throw VALIDATION_FAILED (422). */
export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', { errors: zodIssuesToFieldErrors(result.error.issues) });
  }
  return result.data;
}
