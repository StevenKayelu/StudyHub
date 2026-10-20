import { describe, expect, it } from 'vitest';

import { ConfigurationImportError, previewConfigurationImport } from './env-import';

describe('dashboard .env data import', () => {
  it('previews recognized typed values with comments and quotes', () => {
    const preview = previewConfigurationImport(
      '\uFEFF# example\r\nexport SCHOOL_CATALOG_VISIBILITY="MEMBERS_ONLY" # school\nSCHOOL_COURSE_REVIEW_REQUIRED=false\nSCHOOL_DOWNLOADS_ALLOWED_DEFAULT=\'true\'',
    );
    expect(preview.values).toEqual({
      catalogVisibility: 'MEMBERS_ONLY',
      courseReviewRequired: false,
      downloadsAllowedDefault: true,
    });
    expect(preview.entries).toHaveLength(3);
    expect(preview).not.toHaveProperty('text');
  });

  it.each([
    'DATABASE_URL_APP',
    'IDENTITY_ENCRYPTION_KEY',
    'S3_SECRET_ACCESS_KEY',
    'SMTP_URL',
    'UNSUPPORTED_KEY',
  ])('rejects %s without including its value', (key) => {
    try {
      previewConfigurationImport(`${key}=never-return-this`);
      expect.fail('unsupported key accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationImportError);
      expect((error as Error).message).not.toContain('never-return-this');
      expect((error as Error).message).toContain('not dashboard-managed');
    }
  });

  it.each([
    'SCHOOL_COURSE_REVIEW_REQUIRED=1',
    'SCHOOL_COURSE_REVIEW_REQUIRED=false\nSCHOOL_COURSE_REVIEW_REQUIRED=true',
    'SCHOOL_CATALOG_VISIBILITY=PUBLIC\nDATABASE_URL_APP=secret',
    'SCHOOL_CATALOG_VISIBILITY="PUBLIC',
    'SCHOOL_COURSE_REVIEW_REQUIRED=$(touch /tmp/should-not-exist)',
    'SCHOOL_CATALOG_VISIBILITY=${OTHER_VALUE}',
    '# only comments',
    'x'.repeat(32_769),
    'SCHOOL_COURSE_REVIEW_REQUIRED=true\0',
  ])('rejects invalid imports atomically (%#)', (text) => {
    expect(() => previewConfigurationImport(text)).toThrow(ConfigurationImportError);
  });
});
