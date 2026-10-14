import { lessonDetailSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale } from 'next-intl/server';
import { cache } from 'react';

import { LessonEditor } from '../../../../../../../../components/lesson-editor';
import {
  EDITABLE,
  loadStudioCourse,
  StudioCourseFrame,
} from '../../../../../../../../components/studio-course-frame';
import { fetchContent } from '../../../../../../../../lib/content-api';
import { studioTexts } from '../../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../../lib/tenant';

type Params = Promise<{ id: string; lessonId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const loadLesson = cache(async (courseId: string, lessonId: string) => {
  if (!UUID.test(lessonId)) notFound();
  const lesson = await fetchContent(
    `/api/v1/studio/courses/${courseId}/lessons/${lessonId}`,
    lessonDetailSchema,
  );
  if (lesson === null) notFound();
  return lesson;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id, lessonId } = await params;
  const course = await loadStudioCourse(id);
  return { title: `${(await loadLesson(course.id, lessonId)).title}: ${course.title}` };
}

/** S-T06/S-T07 Lesson editor. */
export default async function LessonPage({ params }: { params: Params }) {
  const { id, lessonId } = await params;
  const course = await loadStudioCourse(id);
  const lesson = await loadLesson(course.id, lessonId);
  const terms = await getTerms(await currentTenant(), await getLocale());
  return (
    <StudioCourseFrame
      course={course}
      tab="outline"
      extraCrumb={{ href: `/studio/courses/${course.id}/lessons/${lesson.id}`, label: lesson.title }}
    >
      <LessonEditor
        courseId={course.id}
        initial={lesson}
        editable={EDITABLE.has(course.status)}
        texts={await studioTexts(terms)}
      />
    </StudioCourseFrame>
  );
}
