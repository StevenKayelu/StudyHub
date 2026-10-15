import { quizListSchema } from '@studyhub/contracts';
import { StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { NewQuizForm } from '../../../../../../../components/new-quiz-form';
import { loadStudioCourse, StudioCourseFrame } from '../../../../../../../components/studio-course-frame';
import { fetchContent } from '../../../../../../../lib/content-api';
import { studioTexts } from '../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const course = await loadStudioCourse((await params).id);
  return { title: `${(await getTranslations('studio.quizzes'))('title')}: ${course.title}` };
}

/** The course's quizzes (S-T06 entry): status, questions and points; new quiz. */
export default async function QuizzesPage({ params }: { params: Params }) {
  const course = await loadStudioCourse((await params).id);
  const t = await getTranslations();
  const terms = await getTerms(await currentTenant(), await getLocale());
  const list =
    (await fetchContent(`/api/v1/studio/courses/${course.id}/quizzes`, quizListSchema))?.items ?? [];
  return (
    <StudioCourseFrame course={course} tab="quizzes">
      <div className="flex flex-col gap-4">
        <h2 className="text-h2">{t('studio.quizzes.title')}</h2>
        <NewQuizForm courseId={course.id} texts={await studioTexts(terms)} />
        {list.length === 0 ? (
          <StatePanel
            kind="empty"
            title={t('studio.quizzes.empty')}
            message={t('studio.quizzes.emptyMessage')}
          />
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {list.map((quiz) => (
              <li key={quiz.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <NextLink
                    href={`/studio/courses/${course.id}/quizzes/${quiz.id}`}
                    className="truncate text-label"
                  >
                    {quiz.title}
                  </NextLink>
                  <span className="text-caption text-muted">
                    {[
                      t('assessment.questions', { count: quiz.questionCount }),
                      t('assessment.points', { count: quiz.totalPoints }),
                      ...(quiz.attemptCount > 0
                        ? [t('studio.results.attempts') + `: ${quiz.attemptCount}`]
                        : []),
                    ].join(' · ')}
                  </span>
                </div>
                <StatusBadge status={quiz.status === 'READY' ? 'published' : 'draft'}>
                  {t(`studio.quizzes.statuses.${quiz.status}`)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </StudioCourseFrame>
  );
}
