import { courseLandingSchema, richTextToPlain } from '@studyhub/contracts';
import { Card } from '@studyhub/ui';
import { CircleCheck, FileText, ListChecks, PlayCircle } from 'lucide-react';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { cache } from 'react';

import { CourseAction } from '../../../../../../components/course-action';
import { durationFormatter, formatPrice } from '../../../../../../components/course-card';
import { PublicFrame } from '../../../../../../components/public-frame';
import { RichText } from '../../../../../../components/rich-text';
import { fetchContent } from '../../../../../../lib/content-api';
import { learnTexts } from '../../../../../../lib/learn-texts';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

type Params = Promise<{ slug: string }>;

const loadCourse = cache((slug: string) =>
  fetchContent(`/api/v1/courses/${encodeURIComponent(slug)}`, courseLandingSchema),
);

const LESSON_ICONS = { TEXT: FileText, VIDEO: PlayCircle, FILE: FileText, QUIZ: ListChecks } as const;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const course = await loadCourse((await params).slug);
  if (course === null) return {};
  const description = (course.subtitle ?? richTextToPlain(course.description)).slice(0, 200);
  return {
    title: course.title,
    description,
    alternates: { canonical: `/c/${course.slug}` },
    openGraph: {
      type: 'website',
      title: course.title,
      description,
      // Cover URLs are short-lived signed links, so sharing previews use the school's own image.
      images: [{ url: '/og.png', width: 1200, height: 630 }],
    },
  };
}

/** S-P03 Course landing: what it is, who teaches it, the outline, and enrolment (F14). */
export default async function CourseLandingPage({ params }: { params: Params }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const course = await loadCourse((await params).slug);
  if (course === null) notFound();
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const duration = await durationFormatter();
  const lessonCount = course.sections.reduce((sum, section) => sum + section.lessons.length, 0);
  return (
    <PublicFrame tenant={tenant} current="browse">
      <article className="grid gap-8 py-4 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            {course.subject !== null ? (
              <NextLink href={`/browse?subject=${course.subject.slug}`} className="text-label">
                {course.subject.name}
              </NextLink>
            ) : null}
            <h1 className="text-h1">{course.title}</h1>
            {course.subtitle !== null ? <p className="text-body-lg text-muted">{course.subtitle}</p> : null}
            <p className="text-body-sm text-muted">
              {course.instructorProfile !== null ? (
                <>
                  {t('catalogue.by', { name: '' })}
                  <NextLink href={`/t/${course.instructorProfile.slug}`}>
                    {course.instructorProfile.name}
                  </NextLink>
                  {' · '}
                </>
              ) : null}
              {t(`catalogue.levels.${course.level}`)} · {t('common.lessons', { count: lessonCount })}
              {course.durationSeconds > 0 ? ` · ${duration(course.durationSeconds)}` : ''}
            </p>
          </header>

          {course.coverUrl !== null ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed object-storage URL
            <img
              src={course.coverUrl}
              alt=""
              width={1280}
              height={720}
              className="aspect-video w-full rounded-md border border-line object-cover"
            />
          ) : null}

          {course.outcomes.length > 0 ? (
            <section aria-labelledby="outcomes" className="flex flex-col gap-3">
              <h2 id="outcomes" className="text-h2">
                {t('course.whatYouLearn')}
              </h2>
              <ul className="grid gap-2 md:grid-cols-2">
                {course.outcomes.map((outcome) => (
                  <li key={outcome} className="flex items-start gap-2">
                    <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
                    <span>{outcome}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="outline" className="flex flex-col gap-3">
            <h2 id="outline" className="text-h2">
              {t('course.outline', terms)}
            </h2>
            <ol className="flex flex-col gap-3">
              {course.sections.map((section, index) => (
                <li key={`${index}-${section.title}`}>
                  <Card className="p-0">
                    <h3 className="border-b border-line px-4 py-3 text-h3">
                      {t('course.section', { number: index + 1, title: section.title })}
                    </h3>
                    <ul className="divide-y divide-line">
                      {section.lessons.map((lesson, lessonIndex) => {
                        const Icon = LESSON_ICONS[lesson.type];
                        return (
                          <li
                            key={`${lessonIndex}-${lesson.title}`}
                            className="flex items-center gap-3 px-4 py-2"
                          >
                            <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" />
                            {lesson.isPreview ? (
                              <NextLink
                                href={`/c/${course.slug}/preview/${lesson.id}`}
                                className="flex-1"
                                aria-label={t('course.previewLink', { title: lesson.title })}
                              >
                                {lesson.title}
                              </NextLink>
                            ) : (
                              <span className="flex-1">{lesson.title}</span>
                            )}
                            <span className="sr-only">{t(`course.lessonTypes.${lesson.type}`)}</span>
                            {lesson.isPreview ? (
                              <span className="text-caption text-accent">{t('course.preview')}</span>
                            ) : null}
                            {lesson.durationSeconds !== null && lesson.durationSeconds > 0 ? (
                              <span className="tabular text-caption text-muted">
                                {duration(lesson.durationSeconds)}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </Card>
                </li>
              ))}
            </ol>
          </section>

          {course.requirements.length > 0 ? (
            <section aria-labelledby="requirements" className="flex flex-col gap-3">
              <h2 id="requirements" className="text-h2">
                {t('course.requirements')}
              </h2>
              <ul className="list-disc ps-6">
                {course.requirements.map((requirement) => (
                  <li key={requirement}>{requirement}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {course.description !== null ? (
            <section aria-labelledby="description" className="flex max-w-reading flex-col gap-3">
              <h2 id="description" className="text-h2">
                {t('course.description', terms)}
              </h2>
              <RichText doc={course.description} />
            </section>
          ) : null}

          {course.instructorProfile !== null ? (
            <section aria-labelledby="instructor" className="flex max-w-reading flex-col gap-2">
              <h2 id="instructor" className="text-h2">
                {t('course.aboutInstructor', terms)}
              </h2>
              <p className="text-h3">
                <NextLink href={`/t/${course.instructorProfile.slug}`}>
                  {course.instructorProfile.name}
                </NextLink>
              </p>
              {course.instructorProfile.headline !== null ? (
                <p className="text-muted">{course.instructorProfile.headline}</p>
              ) : null}
              {course.instructorProfile.bio !== null ? (
                <p className="whitespace-pre-line">{course.instructorProfile.bio}</p>
              ) : null}
            </section>
          ) : null}
        </div>

        <aside className="lg:sticky lg:top-4 lg:self-start">
          <Card className="flex flex-col gap-3">
            <p className="tabular text-h2" data-testid="course-price">
              {await formatPrice(course.priceMinor, course.currency)}
            </p>
            <CourseAction
              course={{ id: course.id, slug: course.slug, priceMinor: course.priceMinor }}
              viewer={course.viewer}
              texts={await learnTexts(terms)}
            />
          </Card>
        </aside>
      </article>
    </PublicFrame>
  );
}
