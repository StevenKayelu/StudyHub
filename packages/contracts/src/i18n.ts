import { z } from 'zod';

/**
 * Languages (blueprint 04 §17.8, BR-61). The platform ships a message catalog per locale; only
 * English exists at launch. A school picks its default and enabled locales from this list.
 */
export const SUPPORTED_LOCALES = ['en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** BCP 47 language tag, restricted to language or language-REGION (e.g. "en", "en-ZM"). */
export const localeSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'must be a language tag like "en"');

/** A tenant-authored text stored per locale: { "en": "Lecturer" } (BR-61). */
export const localizedTextSchema = z.record(localeSchema, z.string().trim().min(1).max(500));
export type LocalizedText = z.infer<typeof localizedTextSchema>;

export const tenantLocaleSettingsSchema = z
  .object({
    defaultLocale: localeSchema,
    enabledLocales: z.array(localeSchema).min(1).max(20),
    timeZone: z.string().min(1).max(64),
  })
  .refine((value) => value.enabledLocales.includes(value.defaultLocale), {
    message: 'enabledLocales must contain defaultLocale',
    path: ['enabledLocales'],
  });
export type TenantLocaleSettings = z.infer<typeof tenantLocaleSettingsSchema>;

/** Settings of a school that has never changed them. */
export const DEFAULT_LOCALE_SETTINGS: TenantLocaleSettings = {
  defaultLocale: 'en',
  enabledLocales: ['en'],
  timeZone: 'Africa/Lusaka',
};

/**
 * A tenant text in the request locale, falling back to the school's default locale when the
 * translation is missing (BR-61). Returns null when neither exists.
 */
export function localizedText(
  text: LocalizedText | null | undefined,
  locale: string,
  defaultLocale: string,
): string | null {
  if (text === null || text === undefined) return null;
  return text[locale] ?? text[defaultLocale] ?? null;
}

/** Parses an Accept-Language header into tags ordered by preference (q-values; ties keep order). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (header === null || header === undefined) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const quality = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((entry) => entry.tag.length > 0 && entry.tag !== '*' && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((entry) => entry.tag);
}

export interface LocaleRequest {
  /** The signed-in user's saved preference (from M4), if any. */
  userPreference?: string | null;
  /** The Accept-Language header; used only for anonymous visitors. */
  acceptLanguage?: string | null;
  settings: Pick<TenantLocaleSettings, 'defaultLocale' | 'enabledLocales'>;
}

/**
 * The locale for a request (04 §17.8): the user's preference if the school still enables it →
 * for anonymous visitors, the best Accept-Language match among enabled locales → the school default.
 * The result is always one of the school's enabled locales, which are a subset of SUPPORTED_LOCALES.
 */
export function resolveRequestLocale({ userPreference, acceptLanguage, settings }: LocaleRequest): string {
  const enabled = settings.enabledLocales.filter((locale) =>
    (SUPPORTED_LOCALES as readonly string[]).includes(locale),
  );
  const fallback = enabled.includes(settings.defaultLocale) ? settings.defaultLocale : (enabled[0] ?? 'en');

  if (userPreference !== undefined && userPreference !== null) {
    return enabled.includes(userPreference) ? userPreference : fallback;
  }
  for (const tag of parseAcceptLanguage(acceptLanguage)) {
    const exact = enabled.find((locale) => locale.toLowerCase() === tag.toLowerCase());
    if (exact !== undefined) return exact;
    const base = tag.split('-')[0]?.toLowerCase();
    const sameLanguage = enabled.find((locale) => locale.split('-')[0] === base);
    if (sameLanguage !== undefined) return sameLanguage;
  }
  return fallback;
}
