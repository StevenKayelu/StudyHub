import { describe, expect, it } from 'vitest';

import type { TenantTx } from '../../platform';
import { effectiveManagedContent, managedOverridesFrom, readContentDefaults } from './content-configuration';

describe('effective managed content policy', () => {
  it('applies platform defaults, school overrides and platform restrictions in order', () => {
    const platform = {
      schemaVersion: 1 as const,
      values: { courseReviewRequired: false, catalogVisibility: 'MEMBERS_ONLY' as const },
      lockedKeys: ['courseReviewRequired' as const],
    };
    const acme = effectiveManagedContent(platform, {
      courseReviewRequired: true,
      catalogVisibility: 'PUBLIC',
    });
    const beta = effectiveManagedContent(platform, {});
    expect(acme).toEqual({
      courseReviewRequired: false,
      catalogVisibility: 'PUBLIC',
      downloadsAllowedDefault: false,
    });
    expect(beta).toEqual({
      courseReviewRequired: false,
      catalogVisibility: 'MEMBERS_ONLY',
      downloadsAllowedDefault: false,
    });
  });

  it('retains false values and ignores unrelated legacy settings', () => {
    expect(
      managedOverridesFrom([
        { key: 'courseReviewRequired', value: false },
        { key: 'timeZone', value: 'Africa/Lusaka' },
      ]),
    ).toEqual({ courseReviewRequired: false });
    expect(() => managedOverridesFrom([{ key: 'catalogVisibility', value: 'bad' }])).toThrow();
  });

  it('adopts defaults only for an absent document and refuses malformed/future data', async () => {
    for (const value of [
      null,
      { schemaVersion: 2, values: {}, lockedKeys: [] },
      { schemaVersion: 1, values: { courseReviewRequired: 'false' }, lockedKeys: [] },
    ]) {
      const tx = { platformSetting: { findUnique: async () => ({ value }) } } as unknown as TenantTx;
      await expect(readContentDefaults(tx)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }
    const tx = { platformSetting: { findUnique: async () => null } } as unknown as TenantTx;
    await expect(readContentDefaults(tx)).resolves.toEqual({ schemaVersion: 1, values: {}, lockedKeys: [] });
  });
});
