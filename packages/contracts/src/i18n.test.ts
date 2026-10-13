import { describe, expect, it } from 'vitest';

import {
  localizedText,
  parseAcceptLanguage,
  resolveRequestLocale,
  SUPPORTED_LOCALES,
  tenantLocaleSettingsSchema,
} from './i18n';

describe('tenant texts (BR-61)', () => {
  it('M3 AC 4: a missing translation falls back to the school default locale', () => {
    const text = { en: 'Lecturer' };
    expect(localizedText(text, 'fr', 'en')).toBe('Lecturer');
  });

  it('uses the requested locale when it is translated', () => {
    expect(localizedText({ en: 'Lecturer', fr: 'Enseignant' }, 'fr', 'en')).toBe('Enseignant');
  });

  it('returns null when neither the locale nor the default exists, so the caller uses the platform term', () => {
    expect(localizedText({ fr: 'Enseignant' }, 'en', 'en')).toBeNull();
    expect(localizedText(undefined, 'en', 'en')).toBeNull();
  });
});

describe('request locale (04 §17.8)', () => {
  // A school with two enabled locales, as if a second catalog had shipped.
  const settings = { defaultLocale: 'en', enabledLocales: ['en', 'fr'] };
  const withFrench = () => {
    (SUPPORTED_LOCALES as unknown as string[]).push('fr');
    return () => (SUPPORTED_LOCALES as unknown as string[]).pop();
  };

  it('prefers the signed-in user preference when the school enables it', () => {
    const restore = withFrench();
    try {
      expect(resolveRequestLocale({ userPreference: 'fr', acceptLanguage: 'en', settings })).toBe('fr');
    } finally {
      restore();
    }
  });

  it('moves a user whose locale was disabled to the school default (BR-61)', () => {
    expect(
      resolveRequestLocale({
        userPreference: 'fr',
        settings: { defaultLocale: 'en', enabledLocales: ['en'] },
      }),
    ).toBe('en');
  });

  it('uses Accept-Language for anonymous visitors, only within enabled locales', () => {
    const restore = withFrench();
    try {
      expect(resolveRequestLocale({ acceptLanguage: 'de-DE, fr-CA;q=0.8, en;q=0.5', settings })).toBe('fr');
      expect(resolveRequestLocale({ acceptLanguage: 'de, es', settings })).toBe('en');
    } finally {
      restore();
    }
  });

  it('never returns a locale without a shipped catalog', () => {
    expect(resolveRequestLocale({ acceptLanguage: 'fr', settings })).toBe('en');
  });

  it('parses Accept-Language by quality, ignoring wildcards and q=0', () => {
    expect(parseAcceptLanguage('en;q=0.5, fr, *;q=0.1, de;q=0')).toEqual(['fr', 'en']);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
  });

  it('requires the default locale to be enabled', () => {
    const result = tenantLocaleSettingsSchema.safeParse({
      defaultLocale: 'fr',
      enabledLocales: ['en'],
      timeZone: 'Africa/Lusaka',
    });
    expect(result.success).toBe(false);
  });
});
