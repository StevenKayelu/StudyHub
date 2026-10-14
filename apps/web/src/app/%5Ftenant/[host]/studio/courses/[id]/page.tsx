import { outlineSchema } from '@studyhub/contracts';
import { Alert } from '@studyhub/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { OutlineEditor } from '../../../../../../components/outline-editor';
import {
  EDITABLE,
  loadStudioCourse,
  StudioCourseFrame,
} from '../../../../../../components/studio-course-frame';
import { fetchContent } from '../../../../../../lib/content-api';
import { studioTexts } from '../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: (await loadStudioCourse((await params).id)).title };
}

/** S-T03 Course outline. */
export default async function OutlinePage({ params }: { params: Params }) {
  const { id } = await params;
  const course = await loadStudioCourse(id);
  const outline = await fetchContent(`/api/v1/studio/courses/${course.id}/outline`, outlineSchema);
  if (outline === null) notFound();
  const tenant = await currentTenant();
  const terms = await getTerms(tenant, await getLocale());
  const t = await getTranslations('studio');
  return (
    <StudioCourseFrame course={course} tab="outline">
      {course.status === 'CHANGES_REQUESTED' && course.reviewNote !== null ? (
        <Alert tone="warning" title={t('publish.changesRequested', { note: course.reviewNote })} />
      ) : null}
      {course.status === 'IN_REVIEW' ? <Alert tone="info" title={t('publish.inReview', terms)} /> : null}
      <OutlineEditor
        initial={outline}
        editable={EDITABLE.has(course.status)}
        texts={await studioTexts(terms)}
      />
    </StudioCourseFrame>
  );
}
