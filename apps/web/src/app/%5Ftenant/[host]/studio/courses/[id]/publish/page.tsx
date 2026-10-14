import { checklistSchema } from '@studyhub/contracts';
import { Alert, buttonClasses, Card } from '@studyhub/ui';
import { CircleCheck, CircleX } from 'lucide-react';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { PublishActions } from '../../../../../../../components/publish-actions';
import { loadStudioCourse, StudioCourseFrame } from '../../../../../../../components/studio-course-frame';
import { fetchContent } from '../../../../../../../lib/content-api';
import { studioTexts } from '../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const course = await loadStudioCourse((await params).id);
  return { title: `${(await getTranslations('studio.tabs'))('publish')}: ${course.title}` };
}

/** S-T08 Publish: the BR-04 checklist with "Fix" links, then submit or publish. */
export default async function PublishPage({ params }: { params: Params }) {
  const course = await loadStudioCourse((await params).id);
  const checklist = await fetchContent(
    `/api/v1/studio/courses/${course.id}/publish-checklist`,
    checklistSchema,
  );
  if (checklist === null) notFound();
  const terms = await getTerms(await currentTenant(), await getLocale());
  const t = await getTranslations('studio.publish');
  return (
    <StudioCourseFrame course={course} tab="publish">
      <div className="flex max-w-reading flex-col gap-5">
        {course.status === 'CHANGES_REQUESTED' && course.reviewNote !== null ? (
          <Alert tone="warning" title={t('changesRequested', { note: course.reviewNote })} />
        ) : null}
        {course.status === 'IN_REVIEW' ? <Alert tone="info" title={t('inReview', terms)} /> : null}
        {course.status === 'PUBLISHED' ? (
          <Alert
            tone="success"
            title={t('published', terms)}
            action={
              <NextLink href={`/c/${course.slug}`} className={buttonClasses('secondary', 'sm')}>
                {t('view')}
              </NextLink>
            }
          />
        ) : null}
        <Card>
          <h2 className="text-h3">{t('checklist')}</h2>
          <ul className="mt-3 flex flex-col divide-y divide-line" data-testid="publish-checklist">
            {checklist.items.map((item) => (
              <li key={item.key} className="flex items-center gap-3 py-2" data-ok={item.ok}>
                {item.ok ? (
                  <CircleCheck aria-label="✓" className="size-5 shrink-0 text-success" />
                ) : (
                  <CircleX aria-label="✗" className="size-5 shrink-0 text-danger" />
                )}
                <span className="flex-1">{item.message}</span>
                {!item.ok ? (
                  <NextLink href={item.fixPath} className="text-label">
                    {t('fix')}
                  </NextLink>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
        {course.status === 'DRAFT' || course.status === 'CHANGES_REQUESTED' ? (
          <p className="text-body-sm text-muted">{t('reviewNotice', terms)}</p>
        ) : null}
        <PublishActions course={course} ready={checklist.ready} texts={await studioTexts(terms)} />
      </div>
    </StudioCourseFrame>
  );
}
