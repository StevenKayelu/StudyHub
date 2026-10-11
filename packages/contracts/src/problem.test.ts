import { describe, expect, it } from 'vitest';

import { ERROR_CODES, ERROR_DEFINITIONS, problemTypeFor } from './errors';
import { problemSchema } from './problem';

const valid = {
  type: problemTypeFor('VALIDATION_FAILED'),
  title: 'Some fields need attention',
  status: 422,
  code: 'VALIDATION_FAILED',
  requestId: 'req_0123456789abcdef',
  errors: [{ field: 'name', code: 'too_small', message: 'Enter a name.' }],
};

describe('problemSchema', () => {
  it('accepts a complete problem document', () => {
    expect(problemSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts RFC 9457 extension members', () => {
    expect(problemSchema.safeParse({ ...valid, checks: { database: 'unavailable' } }).success).toBe(true);
  });

  it('rejects a document without a code', () => {
    const { code: _code, ...withoutCode } = valid;
    expect(problemSchema.safeParse(withoutCode).success).toBe(false);
  });

  it('rejects a document without a requestId', () => {
    const { requestId: _requestId, ...withoutRequestId } = valid;
    expect(problemSchema.safeParse(withoutRequestId).success).toBe(false);
  });

  it('rejects an unknown error code', () => {
    expect(problemSchema.safeParse({ ...valid, code: 'MADE_UP' }).success).toBe(false);
  });

  it('rejects a non-error status', () => {
    expect(problemSchema.safeParse({ ...valid, status: 200 }).success).toBe(false);
  });
});

describe('error definitions', () => {
  it('maps every code to an HTTP error status and a URN type', () => {
    for (const code of ERROR_CODES) {
      const definition = ERROR_DEFINITIONS[code];
      expect(definition.status).toBeGreaterThanOrEqual(400);
      expect(definition.status).toBeLessThan(600);
      expect(problemTypeFor(code)).toMatch(/^urn:studyhub:problem:[a-z-]+$/);
    }
  });
});
