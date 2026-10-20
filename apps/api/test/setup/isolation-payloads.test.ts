import { describe, expect, it } from 'vitest';

import {
  foreignResponseMarkers,
  ISOLATION_PAYLOADS,
  isolationPayload,
  isReferenceValidationDenial,
} from './isolation-payloads';

const ids = Object.fromEntries(
  ['subject', 'asset', 'section', 'lesson', 'category', 'question', 'course'].map((name, index) => [
    name,
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  ]),
);

describe('schema-valid cross-school mutation payloads', () => {
  it('accepts only the documented foreign-subject rejection, not arbitrary invalid fields', () => {
    const problem = { code: 'VALIDATION_FAILED', errors: [{ field: 'subjectId', code: 'not_found' }] };
    expect(isReferenceValidationDenial('POST /api/v1/studio/courses', problem)).toBe(true);
    expect(isReferenceValidationDenial('PATCH /api/v1/studio/courses/:id', problem)).toBe(false);
    expect(
      isReferenceValidationDenial('POST /api/v1/studio/courses', {
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'title', code: 'too_small' }],
      }),
    ).toBe(false);
    expect(isReferenceValidationDenial('POST /api/v1/studio/courses', { code: 'VALIDATION_FAILED' })).toBe(
      false,
    );
  });
  it('does not mistake short sequence ids inside ordinary error responses for tenant data', () => {
    expect(foreignResponseMarkers(['3', '42', '200', ids.subject!, 'Acme Academy'])).toEqual([
      ids.subject,
      'Acme Academy',
    ]);
  });
  it.each(Object.keys(ISOLATION_PAYLOADS))('%s passes its controller contract', (route) => {
    expect(isolationPayload(route, ids)).toBeDefined();
  });
  it('retains foreign references rather than silently stripping them as unknown poison keys', () => {
    expect(isolationPayload('POST /api/v1/studio/courses', ids)).toMatchObject({ subjectId: ids.subject });
    expect(isolationPayload('PUT /api/v1/studio/quizzes/:id/items', ids)).toMatchObject({
      items: [{ questionId: ids.question }],
    });
  });
  it('fails loudly on a missing fixture instead of downgrading the probe', () => {
    expect(() => isolationPayload('POST /api/v1/studio/courses', {})).toThrow(
      'Missing isolation fixture: subject',
    );
  });
});
