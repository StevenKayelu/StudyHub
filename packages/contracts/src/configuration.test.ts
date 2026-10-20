import { describe, expect, it } from 'vitest';

import {
  configurationDraftRequestSchema,
  contentDefaultsDocumentSchema,
  managedContentValuesSchema,
} from './configuration';

describe('managed content configuration contracts', () => {
  it('preserves omitted keys as inheritance rather than injecting defaults', () => {
    expect(managedContentValuesSchema.parse({})).toEqual({});
    expect(managedContentValuesSchema.parse({ courseReviewRequired: false })).toEqual({
      courseReviewRequired: false,
    });
  });

  it('rejects unsupported settings, secret fields and unversioned/future documents', () => {
    expect(managedContentValuesSchema.safeParse({ S3_SECRET_ACCESS_KEY: 'never-return-this' }).success).toBe(
      false,
    );
    expect(managedContentValuesSchema.safeParse({ courseReviewRequired: 'false' }).success).toBe(false);
    expect(contentDefaultsDocumentSchema.safeParse({ values: {}, lockedKeys: [] }).success).toBe(false);
    expect(
      contentDefaultsDocumentSchema.safeParse({ schemaVersion: 2, values: {}, lockedKeys: [] }).success,
    ).toBe(false);
  });

  it('requires a revision and meaningful reason for a draft', () => {
    expect(configurationDraftRequestSchema.safeParse({ values: {}, reason: 'ok' }).success).toBe(false);
    expect(
      configurationDraftRequestSchema.parse({
        expectedRevision: 'a'.repeat(64),
        values: {},
        reason: ' Reset overrides ',
      }),
    ).toMatchObject({ values: {}, lockedKeys: [], reason: 'Reset overrides' });
  });
});
