import { categoryTreeSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { CourseDetailsForm } from '../../../../../../../components/course-details-form';
import {
  EDITABLE,
  loadStudioCourse,
  StudioCourseFrame,
} from '../../../../../../../components/studio-course-frame';
import { fetchContent } from '../../../../../../../lib/content-api';
import { studioTexts } from '../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const course = await loadStudioCourse((await params).id);
  return { title: `${(await getTranslations('studio.tabs'))('details')}: ${course.title}` };
}

/** S-T04 Course details. */
export default async function DetailsPage({ params }: { params: Params }) {
  const course = await loadStudioCourse((await params).id);
  const tree = await fetchContent('/api/v1/categories', categoryTreeSchema);
  const terms = await getTerms(await currentTenant(), await getLocale());
  return (
    <StudioCourseFrame course={course} tab="details">
      <CourseDetailsForm
        course={course}
        categories={tree?.categories ?? []}
        editable={EDITABLE.has(course.status)}
        texts={await studioTexts(terms)}
      />
    </StudioCourseFrame>
  );
}
