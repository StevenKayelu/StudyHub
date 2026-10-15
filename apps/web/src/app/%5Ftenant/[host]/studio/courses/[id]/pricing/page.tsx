import { myEarningsSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { PricingForm } from '../../../../../../../components/pricing-form';
import {
  EDITABLE,
  loadStudioCourse,
  StudioCourseFrame,
} from '../../../../../../../components/studio-course-frame';
import { apiGet } from '../../../../../../../lib/session';
import { studioTexts } from '../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const course = await loadStudioCourse((await params).id);
  return { title: `${(await getTranslations('studio.tabs'))('pricing')}: ${course.title}` };
}

/** S-T05 / S-T07 Pricing and access, with the earnings preview where the school shares revenue. */
export default async function PricingPage({ params }: { params: Params }) {
  const course = await loadStudioCourse((await params).id);
  const tenant = await currentTenant();
  const terms = await getTerms(tenant, await getLocale());
  let commissionBps: number | null = null;
  if (tenant?.features.instructorRevenueShare === true) {
    const response = await apiGet('/api/v1/studio/earnings');
    if (response.ok) commissionBps = myEarningsSchema.parse(await response.json()).commissionBps;
  }
  return (
    <StudioCourseFrame course={course} tab="pricing">
      <PricingForm
        course={course}
        editable={EDITABLE.has(course.status)}
        texts={await studioTexts(terms)}
        commissionBps={commissionBps}
      />
    </StudioCourseFrame>
  );
}
