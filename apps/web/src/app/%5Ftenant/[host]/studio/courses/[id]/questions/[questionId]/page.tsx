import { questionViewSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { cache } from 'react';

import { QuestionEditor } from '../../../../../../../../components/question-editor';
import { loadStudioCourse, StudioCourseFrame } from '../../../../../../../../components/studio-course-frame';
import { fetchContent } from '../../../../../../../../lib/content-api';
import { UUID } from '../../../../../../../../lib/learn-api';
import { studioTexts } from '../../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../../lib/tenant';

type Params = Promise<{ id: string; questionId: string }>;

const load = cache(async (questionId: string) => {
  if (!UUID.test(questionId)) notFound();
  const question = await fetchContent(`/api/v1/studio/questions/${questionId}`, questionViewSchema);
  if (question === null) notFound();
  return question;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { questionId } = await params;
  return {
    title:
      (await load(questionId)).stemText.slice(0, 60) || (await getTranslations('studio.questions'))('edit'),
  };
}

/** S-T05 Edit question (attempts already started keep their own copy, BR-19). */
export default async function EditQuestionPage({ params }: { params: Params }) {
  const { id, questionId } = await params;
  const course = await loadStudioCourse(id);
  const question = await load(questionId);
  if (question.courseId !== course.id) notFound();
  const t = await getTranslations('studio.questions');
  const terms = await getTerms(await currentTenant(), await getLocale());
  return (
    <StudioCourseFrame
      course={course}
      tab="questions"
      extraCrumb={{ href: `/studio/courses/${course.id}/questions/${question.id}`, label: t('edit') }}
    >
      <h2 className="text-h2">{t('edit')}</h2>
      <QuestionEditor courseId={course.id} initial={question} texts={await studioTexts(terms)} />
    </StudioCourseFrame>
  );
}
