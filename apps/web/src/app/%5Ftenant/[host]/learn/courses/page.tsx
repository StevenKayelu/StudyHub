import { myLearningSchema } from '@studyhub/contracts';
import { SecondaryNav, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { LearnFrame } from '../../../../../components/learn-frame';
import { EnrolledGrid } from '../../../../../components/my-learning';
import { fetchContent } from '../../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('learn'))('allTitle') };
}

const FILTERS = ['all', 'inProgress', 'completed'] as const;
type Filter = (typeof FILTERS)[number];

/** Learning: every enrolled course, filtered In progress / Completed (S-L01, F16). */
export default async function LearningPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('learn');
  const terms = await getTerms(tenant, await getLocale());
  const show = (await searchParams).show;
  const filter: Filter = FILTERS.includes(show as Filter) ? (show as Filter) : 'all';
  const items = (await fetchContent('/api/v1/me/enrollments', myLearningSchema))?.items ?? [];
  const shown = items.filter((item) =>
    filter === 'all' ? true : filter === 'completed' ? item.completedAt !== null : item.completedAt === null,
  );
  return (
    <LearnFrame tenant={tenant} current="learning">
      <h1 className="text-h1">{t('allTitle')}</h1>
      <SecondaryNav
        label={t('filter.label')}
        items={FILTERS.map((key) => ({
          href: key === 'all' ? '/learn/courses' : `/learn/courses?show=${key}`,
          label: t(`filter.${key}`),
          current: key === filter,
        }))}
      />
      {shown.length === 0 ? (
        <StatePanel kind="empty" title={items.length === 0 ? t('emptyTitle', terms) : t('noneInFilter')} />
      ) : (
        <EnrolledGrid items={shown} />
      )}
    </LearnFrame>
  );
}
