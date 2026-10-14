import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { PricingForm } from '../../../../../../../components/pricing-form';
import {
  EDITABLE,
  loadStudioCourse,
  StudioCourseFrame,
} from '../../../../../../../components/studio-course-frame';
import { studioTexts } from '../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const course = await loadStudioCourse((await params).id);
  return { title: `${(await getTranslations('studio.tabs'))('pricing')}: ${course.title}` };
}

/** S-T05 Pricing and access. */
export default async function PricingPage({ params }: { params: Params }) {
  const course = await loadStudioCourse((await params).id);
  const terms = await getTerms(await currentTenant(), await getLocale());
  return (
    <StudioCourseFrame course={course} tab="pricing">
      <PricingForm course={course} editable={EDITABLE.has(course.status)} texts={await studioTexts(terms)} />
    </StudioCourseFrame>
  );
}
