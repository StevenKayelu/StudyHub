import 'server-only';

import { getTranslations } from 'next-intl/server';

import type { StudioTexts } from './studio-texts-type';
import type { Terms } from './tenant';
import { fill } from './fill';

/** Fills the school's terms ({courseLower}, …) into every string, leaving other placeholders. */
function withTerms<T>(value: T, terms: Terms): T {
  if (typeof value === 'string') return fill(value, terms) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => withTerms(item, terms)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withTerms(item, terms)])) as T;
  }
  return value;
}

/** Message strings for Studio's client components (raw, with the school's terms filled in). */
export async function studioTexts(terms: Terms): Promise<StudioTexts> {
  const t = await getTranslations();
  return withTerms(
    {
      studio: t.raw('studio') as StudioTexts['studio'],
      common: t.raw('common') as StudioTexts['common'],
      admin: t.raw('admin') as StudioTexts['admin'],
      levels: t.raw('catalogue.levels') as StudioTexts['levels'],
      lessonTypes: t.raw('course.lessonTypes') as StudioTexts['lessonTypes'],
    },
    terms,
  );
}
