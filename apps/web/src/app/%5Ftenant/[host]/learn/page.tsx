import { catalogueResponseSchema, myLearningSchema } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { CourseGrid } from '../../../../components/course-card';
import { LearnFrame } from '../../../../components/learn-frame';
import { ContinueCard, EnrolledGrid } from '../../../../components/my-learning';
import { fetchContent } from '../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('learn'))('title') };
}

/** S-L01 My learning: continue where you left off, then your courses (F16). */
export default async function LearnHomePage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('learn');
  const terms = await getTerms(tenant, await getLocale());
  const mine = await fetchContent('/api/v1/me/enrollments', myLearningSchema);
  const items = mine?.items ?? [];

  if (items.length === 0) {
    const popular = await fetchContent(
      '/api/v1/courses?price=free&sort=popular&limit=4',
      catalogueResponseSchema,
    );
    return (
      <LearnFrame tenant={tenant} current="home">
        <h1 className="text-h1">{t('title')}</h1>
        <StatePanel
          kind="empty"
          title={t('emptyTitle', terms)}
          message={t('emptyMessage', terms)}
          actions={
            <NextLink href="/browse" className={buttonClasses('primary')}>
              {t('browse', terms)}
            </NextLink>
          }
        />
        {popular !== null && popular.items.length > 0 ? (
          <section aria-labelledby="popular" className="flex flex-col gap-3">
            <h2 id="popular" className="text-h2">
              {t('popularFree', terms)}
            </h2>
            <CourseGrid courses={popular.items} />
          </section>
        ) : null}
      </LearnFrame>
    );
  }

  const next = items.find((item) => item.completedAt === null && item.lastAccessedAt !== null) ?? items[0]!;
  const inProgress = items.filter((item) => item.completedAt === null);
  return (
    <LearnFrame tenant={tenant} current="home">
      <h1 className="text-h1">{t('title')}</h1>
      <ContinueCard item={next} />
      <section aria-labelledby="mine" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="mine" className="text-h2">
            {t('myCourses', terms)}
          </h2>
          <NextLink href="/learn/courses" className="text-label">
            {t('seeAll')}
          </NextLink>
        </div>
        <EnrolledGrid items={(inProgress.length > 0 ? inProgress : items).slice(0, 6)} />
      </section>
      <p className="text-caption text-muted">{t('comingNext')}</p>
    </LearnFrame>
  );
}
