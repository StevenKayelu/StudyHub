import { describe, expect, it } from 'vitest';

import { runWithContext } from '../context/request-context';
import { createEnvelope, jobEnvelopeSchema } from './job-envelope';

const TENANT = '0192a0c1-0000-7000-8000-00000000000a';

describe('job envelope (T-ISO-17, unit)', () => {
  it('rejects a tenant job without a tenantId', () => {
    const result = jobEnvelopeSchema.safeParse({
      type: 'course.publish',
      tenantId: null,
      payload: {},
      requestId: 'r1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tenantId that is not a uuid', () => {
    const result = jobEnvelopeSchema.safeParse({
      type: 'course.publish',
      tenantId: 'acme',
      payload: {},
      requestId: 'r1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a system job that carries a tenant', () => {
    const result = jobEnvelopeSchema.safeParse({
      type: 'system.heartbeat',
      tenantId: TENANT,
      payload: {},
      requestId: 'r1',
    });
    expect(result.success).toBe(false);
  });

  it('takes the tenant and request id from the current context', () => {
    const envelope = runWithContext({ requestId: 'req_ctx_1', tenantId: TENANT }, () =>
      createEnvelope('course.publish', { courseId: 'c1' }),
    );
    expect(envelope).toEqual({
      type: 'course.publish',
      tenantId: TENANT,
      payload: { courseId: 'c1' },
      requestId: 'req_ctx_1',
    });
  });

  it('refuses to create a tenant job outside a tenant context', () => {
    expect(() => createEnvelope('course.publish', {})).toThrow();
  });

  it('creates system jobs without a tenant even inside a tenant context', () => {
    const envelope = runWithContext({ requestId: 'req_ctx_2', tenantId: TENANT }, () =>
      createEnvelope('system.heartbeat', { sentAt: '2026-10-11T00:00:00.000Z' }),
    );
    expect(envelope.tenantId).toBeNull();
  });
});
