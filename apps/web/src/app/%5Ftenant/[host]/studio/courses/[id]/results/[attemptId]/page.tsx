import { attemptResultSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { AttemptReview } from '../../../../../../../../components/attempt-review';
import { loadStudioCourse, StudioCourseFrame } from '../../../../../../../../components/studio-course-frame';
import { fetchLearning, UUID } from '../../../../../../../../lib/learn-api';
import { currentTenant, getTerms } from '../../../../../../../../lib/tenant';

type Params = Promise<{ id: string; attemptId: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('studio.results'))('attempt') };
}

/** S-T10 attempt view: the complete review of one learner's attempt (F21 tutor view). */
export default async function StudioAttemptPage({ params }: { params: Params }) {
  const { id, attemptId } = await params;
  const course = await loadStudioCourse(id);
  if (!UUID.test(attemptId)) notFound();
  const result = await fetchLearning(`/api/v1/studio/attempts/${attemptId}`, attemptResultSchema);
  if (result === null || result === 'locked' || result.courseId !== course.id) notFound();
  const terms = await getTerms(await currentTenant(), await getLocale());
  return (
    <StudioCourseFrame
      course={course}
      tab="results"
      extraCrumb={{
        href: `/studio/courses/${course.id}/results/${result.id}`,
        label: `${result.learnerName} · ${result.quizTitle}`,
      }}
    >
      <h2 className="text-h2">
        {result.learnerName} · {result.quizTitle}
      </h2>
      <AttemptReview result={result} terms={terms} />
    </StudioCourseFrame>
  );
}
