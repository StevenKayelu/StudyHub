import 'server-only';

import { getTranslations } from 'next-intl/server';

import type { LearnTexts } from './learn-texts-type';
import { withTerms } from './studio-texts';
import type { Terms } from './tenant';

/** Message strings for the learner space's client components, with the school's terms filled in. */
export async function learnTexts(terms: Terms): Promise<LearnTexts> {
  const t = await getTranslations();
  return withTerms(
    {
      player: t.raw('learn.player') as LearnTexts['player'],
      video: t.raw('learn.video') as LearnTexts['video'],
      cta: t.raw('course.cta') as LearnTexts['cta'],
      common: t.raw('common') as LearnTexts['common'],
    },
    terms,
  );
}
