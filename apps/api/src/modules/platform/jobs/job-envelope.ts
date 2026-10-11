import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { currentContext } from '../context/request-context';

/** Platform-level jobs that legitimately have no tenant. Every other job MUST carry a tenantId. */
export const SYSTEM_JOB_PREFIX = 'system.';

/**
 * Every background job carries this envelope (blueprint 04 §17.11, threat T12). `type` is the queue
 * name, `tenantId` decides the tenant context the handler runs in, `requestId` links the job to the
 * request that caused it.
 */
export const jobEnvelopeSchema = z
  .object({
    type: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, 'must be a dotted lower-case job type'),
    tenantId: z.uuid().nullable(),
    payload: z.record(z.string(), z.unknown()),
    requestId: z.string().min(1).max(128),
  })
  .superRefine((envelope, context) => {
    const isSystem = envelope.type.startsWith(SYSTEM_JOB_PREFIX);
    if (isSystem && envelope.tenantId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['tenantId'],
        message: 'system jobs must not carry a tenant',
      });
    }
    if (!isSystem && envelope.tenantId === null) {
      context.addIssue({ code: 'custom', path: ['tenantId'], message: 'tenant jobs require a tenantId' });
    }
  });

export type JobEnvelope<P extends Record<string, unknown> = Record<string, unknown>> = Omit<
  z.infer<typeof jobEnvelopeSchema>,
  'payload'
> & { payload: P };

export interface EnvelopeOptions {
  /** Defaults to the current context's tenant for tenant jobs; system jobs must not set it. */
  tenantId?: string | null;
  requestId?: string;
}

export function createEnvelope<P extends Record<string, unknown>>(
  type: string,
  payload: P,
  options: EnvelopeOptions = {},
): JobEnvelope<P> {
  const context = currentContext();
  const isSystem = type.startsWith(SYSTEM_JOB_PREFIX);
  const tenantId =
    options.tenantId !== undefined ? options.tenantId : isSystem ? null : (context?.tenantId ?? null);
  const requestId = options.requestId ?? context?.requestId ?? `job_${randomUUID()}`;
  return jobEnvelopeSchema.parse({ type, tenantId, payload, requestId }) as JobEnvelope<P>;
}
