import 'server-only';

import type { PlayerCourse } from '@studyhub/contracts';
import { Banner, ProgressLine, SkipLink } from '@studyhub/ui';
import { ArrowLeft, Circle, CircleCheck, CircleDot, ListChecks } from 'lucide-react';
import NextLink from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import type { Terms } from '../lib/tenant';

/**
 * The course player's frame (S-L02, 06 §1 "content first, chrome last"): a slim top bar with the way
 * back, the course title and its progress line; the outline as a 320 px rail on wide screens and a
 * disclosure above the lesson on narrow ones.
 */
export async function PlayerFrame({
  course,
  currentLessonId,
  terms,
  children,
}: {
  course: PlayerCourse;
  currentLessonId: string | null;
  terms: Terms;
  children: ReactNode;
}) {
  const t = await getTranslations();
  const p = (key: string, values: Record<string, string | number> = {}) =>
    t(`learn.player.${key}`, { ...terms, ...values });
  const { required, completedRequired } = course.counts;
  const notices: string[] = [];
  if (course.readOnly) notices.push(p('readOnly'));
  if (course.access === 'OWNER') notices.push(p('ownerPreview'));
  if (course.access === 'ADMIN') notices.push(p('adminPreview'));
  if (course.access === 'ENROLLED' && course.course.status !== 'PUBLISHED') notices.push(p('unpublished'));
  const back = course.course.status === 'PUBLISHED' ? `/c/${course.course.slug}` : '/learn';

  const outline = (
    <nav aria-label={p('outline')} className="flex flex-col gap-4">
      {course.sections.map((section) => (
        <div key={section.id} className="flex flex-col gap-1">
          <h2 className="text-label text-muted">{section.title}</h2>
          <ol className="flex flex-col border-s-[3px] border-line">
            {section.lessons.map((lesson) => {
              const current = lesson.id === currentLessonId;
              const state = current ? 'CURRENT' : lesson.status;
              const Icon =
                lesson.status === 'COMPLETED'
                  ? CircleCheck
                  : current
                    ? CircleDot
                    : lesson.type === 'QUIZ'
                      ? ListChecks
                      : Circle;
              return (
                <li key={lesson.id} className="-ms-[3px]">
                  <NextLink
                    href={`/learn/courses/${course.course.id}/lessons/${lesson.id}`}
                    aria-current={current ? 'page' : undefined}
                    className={`flex min-h-11 items-center gap-2 border-s-[3px] px-3 py-2 no-underline ${
                      current
                        ? 'border-accent bg-accent-soft text-ink'
                        : 'border-transparent text-ink hover:bg-sunken'
                    }`}
                  >
                    <Icon
                      aria-hidden="true"
                      className={`size-4 shrink-0 ${
                        lesson.status === 'COMPLETED'
                          ? 'text-success'
                          : current
                            ? 'text-accent'
                            : 'text-muted'
                      }`}
                    />
                    <span className="flex-1">{lesson.title}</span>
                    <span className="sr-only">{p(`states.${state}`)}</span>
                  </NextLink>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <SkipLink label={t('common.skipToContent')} />
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex max-w-app items-center gap-3 px-4 py-2">
          <NextLink
            href={back}
            className="flex min-h-11 items-center gap-1 text-label no-underline"
            aria-label={p('backToCourse')}
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
          </NextLink>
          <p className="min-w-0 flex-1 truncate text-label">{course.course.title}</p>
        </div>
        {course.enrollment !== null ? (
          <ProgressLine
            value={completedRequired}
            max={Math.max(required, 1)}
            label={p('progressLabel', { done: completedRequired, total: required })}
            className="[&>span]:sr-only"
          />
        ) : null}
      </header>
      {notices.map((notice) => (
        <Banner key={notice} tone="info">
          {notice}
        </Banner>
      ))}
      <div className="mx-auto grid w-full max-w-app flex-1 gap-6 px-4 py-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="hidden lg:block">{outline}</aside>
        <main id="content" className="flex min-w-0 flex-col gap-4">
          <details className="rounded-md border border-line bg-surface lg:hidden">
            <summary className="flex min-h-11 cursor-pointer items-center px-4 text-label">
              {p('openOutline')}
            </summary>
            <div className="border-t border-line p-3">{outline}</div>
          </details>
          {children}
        </main>
      </div>
    </div>
  );
}
