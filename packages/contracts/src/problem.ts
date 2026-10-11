import { z } from 'zod';

import { errorCodeSchema } from './errors';

/** Media type for every error response (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const problemFieldErrorSchema = z.object({
  field: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
});

/**
 * RFC 9457 problem details with StudyHub's required members (`code`, `requestId`).
 * Extension members (e.g. `checks` on readiness failures) are allowed, as RFC 9457 permits.
 */
export const problemSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    code: errorCodeSchema,
    detail: z.string().optional(),
    instance: z.string().optional(),
    requestId: z.string().min(1),
    errors: z.array(problemFieldErrorSchema).optional(),
  })
  .loose();

export type ProblemFieldError = z.infer<typeof problemFieldErrorSchema>;
export type Problem = z.infer<typeof problemSchema>;
