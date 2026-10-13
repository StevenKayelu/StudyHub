import { DEFAULT_LOCALE_SETTINGS, resolveRequestLocale } from '@studyhub/contracts';
import { headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { currentTenant } from '../lib/tenant';
import { loadMessages } from './messages';

/**
 * Locale per request (04 §17.8, BR-61), without locale prefixes in URLs: the school's enabled
 * locales decide. User preferences join in M4; until then anonymous Accept-Language applies, limited
 * to the school's enabled locales, falling back to its default.
 */
export default getRequestConfig(async () => {
  const tenant = await currentTenant();
  const settings = tenant?.locales ?? DEFAULT_LOCALE_SETTINGS;
  const locale = resolveRequestLocale({
    acceptLanguage: (await headers()).get('accept-language'),
    settings,
  });
  return {
    locale,
    messages: await loadMessages(locale, settings.defaultLocale),
    timeZone: settings.timeZone,
  };
});
