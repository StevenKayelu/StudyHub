import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { QuestionEditor } from '../../../../../../../../components/question-editor';
import { loadStudioCourse, StudioCourseFrame } from '../../../../../../../../components/studio-course-frame';
import { studioTexts } from '../../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const course = await loadStudioCourse((await params).id);
  return { title: `${(await getTranslations('studio.questions'))('new')}: ${course.title}` };
}

/** S-T05 New question. */
export default async function NewQuestionPage({ params }: { params: Params }) {
  const course = await loadStudioCourse((await params).id);
  const t = await getTranslations('studio.questions');
  const terms = await getTerms(await currentTenant(), await getLocale());
  return (
    <StudioCourseFrame
      course={course}
      tab="questions"
      extraCrumb={{ href: `/studio/courses/${course.id}/questions/new`, label: t('new') }}
    >
      <h2 className="text-h2">{t('new')}</h2>
      <QuestionEditor courseId={course.id} initial={null} texts={await studioTexts(terms)} />
    </StudioCourseFrame>
  );
}
