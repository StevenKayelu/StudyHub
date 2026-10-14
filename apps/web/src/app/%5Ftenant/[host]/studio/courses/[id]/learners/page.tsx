import { courseLearnersSchema } from '@studyhub/contracts';
import { ProgressLine, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';

import { loadStudioCourse, StudioCourseFrame } from '../../../../../../../components/studio-course-frame';
import { fetchContent } from '../../../../../../../lib/content-api';

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const course = await loadStudioCourse((await params).id);
  return { title: `${(await getTranslations('studio.tabs'))('learners')}: ${course.title}` };
}

/** S-T09 Learners: who is enrolled and how far they are (display names only, Q-PRIV-2). */
export default async function LearnersPage({ params }: { params: Params }) {
  const course = await loadStudioCourse((await params).id);
  const t = await getTranslations('studio.learners');
  const format = await getFormatter();
  const learners =
    (await fetchContent(`/api/v1/studio/courses/${course.id}/learners`, courseLearnersSchema))?.items ?? [];
  const date = (value: string | null) =>
    value === null ? t('never') : format.dateTime(new Date(value), { dateStyle: 'medium' });
  return (
    <StudioCourseFrame course={course} tab="learners">
      {learners.length === 0 ? (
        <StatePanel kind="empty" title={t('empty')} message={t('emptyMessage')} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full text-body-sm">
            <caption className="sr-only">{t('title')}</caption>
            <thead className="border-b border-line text-label">
              <tr>
                <th scope="col" className="p-3 text-start">
                  {t('name')}
                </th>
                <th scope="col" className="p-3 text-start">
                  {t('enrolled')}
                </th>
                <th scope="col" className="min-w-40 p-3 text-start">
                  {t('progress')}
                </th>
                <th scope="col" className="p-3 text-start">
                  {t('lastActive')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {learners.map((learner) => (
                <tr key={learner.enrollmentId}>
                  <th scope="row" className="p-3 text-start font-normal">
                    {learner.name}
                  </th>
                  <td className="p-3">{date(learner.startedAt)}</td>
                  <td className="p-3">
                    <ProgressLine
                      value={learner.progressPercent}
                      max={100}
                      label={learner.completedAt !== null ? t('completed') : `${learner.progressPercent}%`}
                    />
                  </td>
                  <td className="p-3">{date(learner.lastAccessedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StudioCourseFrame>
  );
}
