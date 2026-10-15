import { catalogueResponseSchema, myAssessmentsSchema, myLearningSchema } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

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
  const assessments = await fetchContent('/api/v1/me/assessments', myAssessmentsSchema);
  const format = await getFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const tAll = await getTranslations();
  return (
    <LearnFrame tenant={tenant} current="home">
      <h1 className="text-h1">{t('title')}</h1>
      <ContinueCard item={next} />
      {assessments !== null && assessments.open.length > 0 ? (
        <section aria-labelledby="open-quizzes" className="flex flex-col gap-2" data-testid="open-quizzes">
          <h2 id="open-quizzes" className="text-h2">
            {t('openQuizzes')}
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {assessments.open.map((quiz) => (
              <li key={quiz.quizId} className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <NextLink href={`/learn/quizzes/${quiz.quizId}`} className="truncate text-label">
                    {quiz.title}
                  </NextLink>
                  <span className="text-caption text-muted">
                    {quiz.courseTitle}
                    {quiz.closesAt !== null ? ` · ${t('closes', { date: date(quiz.closesAt) })}` : ''}
                  </span>
                </div>
                {quiz.inProgressAttemptId !== null ? (
                  <NextLink href={`/learn/attempts/${quiz.inProgressAttemptId}`} className="text-label">
                    {t('resumeAttempt')}
                  </NextLink>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
      {assessments !== null && assessments.recent.length > 0 ? (
        <section aria-labelledby="recent-results" className="flex flex-col gap-2">
          <h2 id="recent-results" className="text-h2">
            {t('recentResults')}
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {assessments.recent.map((result) => (
              <li key={result.attemptId} className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <NextLink
                    href={`/learn/attempts/${result.attemptId}/result`}
                    className="truncate text-label"
                  >
                    {result.quizTitle}
                  </NextLink>
                  <span className="text-caption text-muted">{result.courseTitle}</span>
                </div>
                <span className="tabular text-body-sm">
                  {result.status === 'NEEDS_REVIEW'
                    ? tAll('assessment.attemptStatuses.NEEDS_REVIEW')
                    : result.percent !== null
                      ? `${result.percent} %${result.passed !== null ? ` · ${result.passed ? tAll('assessment.passed') : tAll('assessment.failed')}` : ''}`
                      : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </LearnFrame>
  );
}
