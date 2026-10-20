import { playerCourseSchema } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import NextLink from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { fetchLearning, UUID } from '../../../../../../lib/learn-api';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

/**
 * Opening a course goes straight to where the learner left off (F16 AC): the resume lesson, else the
 * first lesson not yet completed, else the first lesson.
 */
export default async function CoursePlayerEntry({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  if (!UUID.test(courseId)) notFound();
  const course = await fetchLearning(`/api/v1/learn/courses/${courseId}`, playerCourseSchema);
  if (course === null) notFound();
  const tenant = await currentTenant();
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const lessons = course === 'locked' ? [] : course.sections.flatMap((section) => section.lessons);
  if (course !== 'locked') {
    const target =
      course.resume?.lessonId ??
      lessons.find((lesson) => lesson.status !== 'COMPLETED' && !lesson.locked)?.id ??
      lessons[0]?.id;
    if (target !== undefined) redirect(`/learn/courses/${courseId}/lessons/${target}`);
  }
  return (
    <main id="content" className="mx-auto flex min-h-dvh max-w-reading items-center px-4">
      <StatePanel
        kind={course === 'locked' ? 'permission' : 'empty'}
        headingLevel={1}
        title={course === 'locked' ? t('course.previewCta', terms) : t('learn.player.noContent')}
        actions={
          <NextLink href="/learn" className={buttonClasses('primary')}>
            {t('learn.title')}
          </NextLink>
        }
      />
    </main>
  );
}
