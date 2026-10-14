import { playerCourseSchema, playerLessonSchema } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { cache } from 'react';

import { LessonPlayer } from '../../../../../../../../components/lesson-player';
import { PlayerFrame } from '../../../../../../../../components/player-frame';
import { RichText } from '../../../../../../../../components/rich-text';
import { fetchLearning, UUID } from '../../../../../../../../lib/learn-api';
import { learnTexts } from '../../../../../../../../lib/learn-texts';
import { currentTenant, getTerms } from '../../../../../../../../lib/tenant';

type Params = Promise<{ courseId: string; lessonId: string }>;

const load = cache(async (courseId: string, lessonId: string) => {
  if (!UUID.test(courseId) || !UUID.test(lessonId)) notFound();
  const [course, lesson] = await Promise.all([
    fetchLearning(`/api/v1/learn/courses/${courseId}`, playerCourseSchema),
    fetchLearning(`/api/v1/learn/lessons/${lessonId}`, playerLessonSchema),
  ]);
  if (course === null || lesson === null) notFound();
  if (course !== 'locked' && lesson !== 'locked' && lesson.courseId !== course.course.id) notFound();
  return { course, lesson };
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { courseId, lessonId } = await params;
  const { course, lesson } = await load(courseId, lessonId);
  if (course === 'locked' || lesson === 'locked') return { robots: { index: false } };
  return { title: `${lesson.title} · ${course.course.title}`, robots: { index: false } };
}

/** S-L02 Course player: one lesson with the outline, progress and previous/next (F15). */
export default async function LessonPage({ params }: { params: Params }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const { courseId, lessonId } = await params;
  const { course, lesson } = await load(courseId, lessonId);
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());

  if (course === 'locked' || lesson === 'locked') {
    // F15 AC 2: no enrolment, no content. The learner goes back to the course page to enrol.
    return (
      <main id="content" className="mx-auto flex min-h-dvh max-w-reading items-center px-4">
        <StatePanel
          kind="permission"
          headingLevel={1}
          title={t('course.previewCta', terms)}
          actions={
            <NextLink href="/browse" className={buttonClasses('primary')}>
              {t('learn.browse', terms)}
            </NextLink>
          }
        />
      </main>
    );
  }

  const lessons = course.sections.flatMap((section) => section.lessons);
  const number = lessons.findIndex((l) => l.id === lesson.id) + 1;
  const courseHref = `/learn/courses/${course.course.id}`;
  return (
    <PlayerFrame course={course} currentLessonId={lesson.id} terms={terms}>
      <header className="flex flex-col gap-1">
        <p className="text-caption text-muted">
          {t('learn.player.lessonOf', { number, total: lessons.length })} ·{' '}
          {t(`course.lessonTypes.${lesson.type}`)}
        </p>
        <h1 className="text-h1">{lesson.title}</h1>
      </header>
      <LessonPlayer
        key={lesson.id}
        lesson={lesson}
        canSave={course.access === 'ENROLLED' && !course.readOnly}
        texts={await learnTexts(terms)}
        courseHref={courseHref}
        completeHref={`${courseHref}/complete`}
      >
        {lesson.content !== null ? (
          <RichText doc={lesson.content} images={lesson.images} className="max-w-reading" />
        ) : lesson.type === 'TEXT' ? (
          <p className="text-muted">{t('learn.player.noContent')}</p>
        ) : null}
      </LessonPlayer>
      <p className="hidden text-caption text-muted lg:block">{t('learn.player.keyboardHint')}</p>
    </PlayerFrame>
  );
}
