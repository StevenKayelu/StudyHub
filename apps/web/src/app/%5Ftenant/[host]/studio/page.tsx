import { studioCourseListSchema } from '@studyhub/contracts';
import { Card, StatePanel, StatusBadge } from '@studyhub/ui';
import { BookOpen } from 'lucide-react';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { NewCourseForm } from '../../../../components/new-course-form';
import { COURSE_BADGES } from '../../../../components/studio-course-frame';
import { StudioFrame } from '../../../../components/workspace-frames';
import { fetchContent } from '../../../../lib/content-api';
import { studioTexts } from '../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('studio'))('home') };
}

/** S-T02 Studio home: the instructor's courses and "New course". */
export default async function StudioHomePage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('studio');
  const format = await getFormatter();
  const terms = await getTerms(tenant, await getLocale());
  const list = await fetchContent('/api/v1/studio/courses', studioCourseListSchema);
  const courses = list?.courses ?? [];
  return (
    <StudioFrame
      tenant={tenant}
      title={t('title', terms)}
      breadcrumbs={[
        { href: '/studio', label: t('home') },
        { href: '/studio', label: t('title', terms) },
      ]}
    >
      <div className="flex flex-col gap-6">
        <Card>
          <h2 className="mb-3 text-h3">{t('newCourseTitle', terms)}</h2>
          <NewCourseForm texts={await studioTexts(terms)} />
        </Card>
        {courses.length === 0 ? (
          <StatePanel kind="empty" title={t('emptyTitle', terms)} message={t('emptyMessage')} />
        ) : (
          <ul
            className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface"
            data-testid="studio-courses"
          >
            {courses.map((course) => (
              <li key={course.id} className="flex items-center gap-4 p-3">
                <div className="hidden aspect-video w-28 shrink-0 overflow-hidden rounded-sm bg-sunken sm:block">
                  {course.coverUrl !== null ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed object-storage URL
                    <img src={course.coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted" aria-hidden="true">
                      <BookOpen className="size-5" strokeWidth={1.25} />
                    </div>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <NextLink href={`/studio/courses/${course.id}`} className="truncate text-label">
                    {course.title}
                  </NextLink>
                  <span className="text-caption text-muted">
                    {t('updated', {
                      date: format.dateTime(new Date(course.updatedAt), { dateStyle: 'medium' }),
                    })}
                  </span>
                </div>
                <StatusBadge status={COURSE_BADGES[course.status]}>
                  {t(`statuses.${course.status}`)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </StudioFrame>
  );
}
