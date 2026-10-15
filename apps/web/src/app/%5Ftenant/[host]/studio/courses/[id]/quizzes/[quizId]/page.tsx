import { questionListSchema, quizViewSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { cache } from 'react';

import { QuizBuilder } from '../../../../../../../../components/quiz-builder';
import { loadStudioCourse, StudioCourseFrame } from '../../../../../../../../components/studio-course-frame';
import { fetchContent } from '../../../../../../../../lib/content-api';
import { UUID } from '../../../../../../../../lib/learn-api';
import { studioTexts } from '../../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../../lib/tenant';

type Params = Promise<{ id: string; quizId: string }>;

const load = cache(async (quizId: string) => {
  if (!UUID.test(quizId)) notFound();
  const quiz = await fetchContent(`/api/v1/studio/quizzes/${quizId}`, quizViewSchema);
  if (quiz === null) notFound();
  return quiz;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: (await load((await params).quizId)).title };
}

/** S-T06 Quiz builder. */
export default async function QuizBuilderPage({ params }: { params: Params }) {
  const { id, quizId } = await params;
  const course = await loadStudioCourse(id);
  const quiz = await load(quizId);
  if (quiz.courseId !== course.id) notFound();
  const terms = await getTerms(await currentTenant(), await getLocale());
  const bank =
    (await fetchContent(`/api/v1/studio/courses/${course.id}/questions`, questionListSchema))?.items ?? [];
  return (
    <StudioCourseFrame
      course={course}
      tab="quizzes"
      extraCrumb={{ href: `/studio/courses/${course.id}/quizzes/${quiz.id}`, label: quiz.title }}
    >
      <QuizBuilder initial={quiz} bank={bank} texts={await studioTexts(terms)} />
    </StudioCourseFrame>
  );
}
