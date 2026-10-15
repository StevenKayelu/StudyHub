import 'server-only';

import { getTranslations } from 'next-intl/server';

import type { CommerceTexts } from './commerce-texts-type';
import { withTerms } from './studio-texts';
import type { Terms } from './tenant';

/** Message strings for the commerce client components (M8), with the school's terms filled in. */
export async function commerceTexts(terms: Terms): Promise<CommerceTexts> {
  const t = await getTranslations();
  return withTerms(
    {
      commerce: t.raw('commerce') as CommerceTexts['commerce'],
      common: t.raw('common') as CommerceTexts['common'],
    },
    terms,
  );
}
