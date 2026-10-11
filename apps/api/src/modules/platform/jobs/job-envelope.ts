import { randomUUID } from 'node:crypto';

import { z } from 'zod';

/**
 * Every background job carries this envelope. `type` is the queue name, `requestId` links the job
 * to the request that caused it (for log correlation).
 *
 * M2 (tenancy kernel) adds a required `tenantId` (blueprint 04 §17.11). Until then no job may touch
 * tenant data — there is none.
 */
export const jobEnvelopeSchema = z.object({
  type: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, 'must be a dotted lower-case job type'),
  payload: z.record(z.string(), z.unknown()),
  requestId: z.string().min(1).max(128),
});

export type JobEnvelope<P extends Record<string, unknown> = Record<string, unknown>> = Omit<
  z.infer<typeof jobEnvelopeSchema>,
  'payload'
> & { payload: P };

export function createEnvelope<P extends Record<string, unknown>>(
  type: string,
  payload: P,
  requestId: string = `job_${randomUUID()}`,
): JobEnvelope<P> {
  return jobEnvelopeSchema.parse({ type, payload, requestId }) as JobEnvelope<P>;
}
