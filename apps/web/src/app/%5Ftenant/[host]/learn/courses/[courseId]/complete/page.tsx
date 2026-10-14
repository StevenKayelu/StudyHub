import { playerCourseSchema } from '@studyhub/contracts';
import { buttonClasses, Card } from '@studyhub/ui';
import { PartyPopper } from 'lucide-react';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { PlayerFrame } from '../../../../../../../components/player-frame';
import { fetchLearning, UUID } from '../../../../../../../lib/learn-api';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('learn'))('completed'), robots: { index: false } };
}

/** S-L03 Course completed (BR-22): the completion moment, then back to review or to browse. */
export default async function CourseCompletePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  if (!UUID.test(courseId)) notFound();
  const course = await fetchLearning(`/api/v1/learn/courses/${courseId}`, playerCourseSchema);
  if (course === null || course === 'locked') notFound();
  if (course.enrollment === null || course.enrollment.completedAt === null)
    redirect(`/learn/courses/${courseId}`);
  const tenant = await currentTenant();
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const completed = course.sections.flatMap((s) => s.lessons).filter((l) => l.status === 'COMPLETED').length;
  return (
    <PlayerFrame course={course} currentLessonId={null} terms={terms}>
      <Card className="flex flex-col items-start gap-4 p-6">
        <PartyPopper aria-hidden="true" className="size-10 text-accent" />
        <h1 className="text-h1">{t('learn.complete.title', { course: course.course.title })}</h1>
        <p className="text-body-lg">{t('learn.complete.message')}</p>
        <p className="text-muted">{t('learn.complete.lessons', { count: completed })}</p>
        <div className="flex flex-wrap gap-3">
          <NextLink
            href={`/learn/courses/${courseId}/lessons/${course.sections[0]?.lessons[0]?.id ?? ''}`}
            className={buttonClasses('secondary')}
          >
            {t('learn.complete.review', terms)}
          </NextLink>
          <NextLink href="/browse" className={buttonClasses('primary')}>
            {t('learn.complete.browse', terms)}
          </NextLink>
        </div>
        <p className="text-caption text-muted">{t('learn.complete.certificateSoon')}</p>
      </Card>
    </PlayerFrame>
  );
}
