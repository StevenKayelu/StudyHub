import { playerLessonSchema } from '@studyhub/contracts';
import { buttonClasses } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { cache } from 'react';

import { LessonPlayer } from '../../../../../../../../components/lesson-player';
import { PublicFrame } from '../../../../../../../../components/public-frame';
import { RichText } from '../../../../../../../../components/rich-text';
import { fetchLearning, UUID } from '../../../../../../../../lib/learn-api';
import { learnTexts } from '../../../../../../../../lib/learn-texts';
import { currentTenant, getTerms } from '../../../../../../../../lib/tenant';

type Params = Promise<{ slug: string; lessonId: string }>;

const load = cache(async (slug: string, lessonId: string) => {
  if (!UUID.test(lessonId)) notFound();
  const lesson = await fetchLearning(`/api/v1/learn/lessons/${lessonId}`, playerLessonSchema);
  // A locked lesson isn't a preview: not found here (the landing page offers enrolment).
  if (lesson === null || lesson === 'locked' || lesson.courseSlug !== slug) notFound();
  return lesson;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, lessonId } = await params;
  const lesson = await load(slug, lessonId);
  const t = await getTranslations('course');
  return { title: t('previewTitle', { title: lesson.title }), alternates: { canonical: `/c/${slug}` } };
}

/** A preview lesson, open to every visitor who can see the catalogue (S-P03 "Preview lessons"). */
export default async function PreviewLessonPage({ params }: { params: Params }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const { slug, lessonId } = await params;
  const lesson = await load(slug, lessonId);
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  return (
    <PublicFrame tenant={tenant} current="browse">
      <article className="flex max-w-reading flex-col gap-4 py-4">
        <NextLink href={`/c/${slug}`} className="text-label">
          {lesson.courseTitle}
        </NextLink>
        <h1 className="text-h1">{t('course.previewTitle', { title: lesson.title })}</h1>
        <LessonPlayer
          lesson={lesson}
          canSave={false}
          texts={await learnTexts(terms)}
          courseHref={`/learn/courses/${lesson.courseId}`}
          completeHref={`/learn/courses/${lesson.courseId}/complete`}
        >
          {lesson.content !== null ? <RichText doc={lesson.content} images={lesson.images} /> : null}
        </LessonPlayer>
        <NextLink href={`/c/${slug}`} className={`${buttonClasses('primary')} self-start`}>
          {t('course.previewCta', terms)}
        </NextLink>
      </article>
    </PublicFrame>
  );
}
