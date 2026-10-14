import { instructorPageSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { cache } from 'react';

import { CourseGrid } from '../../../../../../components/course-card';
import { PublicFrame } from '../../../../../../components/public-frame';
import { fetchContent } from '../../../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

type Params = Promise<{ slug: string }>;

const loadInstructor = cache((slug: string) =>
  fetchContent(`/api/v1/instructors/${encodeURIComponent(slug)}`, instructorPageSchema),
);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const instructor = await loadInstructor((await params).slug);
  if (instructor === null) return {};
  return { title: instructor.displayName, description: instructor.headline ?? undefined };
}

/** S-P04 Instructor page: profile and published courses. */
export default async function InstructorPage({ params }: { params: Params }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const instructor = await loadInstructor((await params).slug);
  if (instructor === null) notFound();
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  return (
    <PublicFrame tenant={tenant}>
      <div className="flex flex-col gap-8 py-4">
        <header className="flex max-w-reading flex-col gap-2">
          <h1 className="text-h1">{instructor.displayName}</h1>
          {instructor.headline !== null ? (
            <p className="text-body-lg text-muted">{instructor.headline}</p>
          ) : null}
          {instructor.subjects.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label={t('instructor.subjects')}>
              {instructor.subjects.map((subject) => (
                <li key={subject} className="rounded-full bg-sunken px-3 py-0.5 text-caption text-muted">
                  {subject}
                </li>
              ))}
            </ul>
          ) : null}
          {instructor.bio !== null ? <p className="whitespace-pre-line">{instructor.bio}</p> : null}
        </header>
        {instructor.courses.length > 0 ? (
          <section aria-labelledby="courses" className="flex flex-col gap-4">
            <h2 id="courses" className="text-h2">
              {t('course.coursesBy', { ...terms, name: instructor.displayName })}
            </h2>
            <CourseGrid courses={instructor.courses} />
          </section>
        ) : null}
      </div>
    </PublicFrame>
  );
}
