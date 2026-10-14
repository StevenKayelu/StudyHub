import 'server-only';

import type { CourseCard as Card } from '@studyhub/contracts';
import { formatMoney } from '@studyhub/ui';
import { BookOpen } from 'lucide-react';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

/** A formatter for "1 h 20 min" or "45 min" (synchronous once loaded, for use inside lists). */
export async function durationFormatter(): Promise<(seconds: number) => string> {
  const t = await getTranslations('common');
  return (seconds) => {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return t('minutes', { count: minutes });
    return t('hoursMinutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  };
}

export async function formatDuration(seconds: number): Promise<string> {
  return (await durationFormatter())(seconds);
}

/** Price as "K250.00", or "Free" (06 §2.5). */
export async function formatPrice(priceMinor: number, currency: string): Promise<string> {
  const t = await getTranslations('common');
  if (priceMinor === 0) return t('free');
  // The narrow symbol for ZMW is "K" in en-ZM.
  const locale = await getLocale();
  return formatMoney(priceMinor, currency, locale === 'en' ? 'en-ZM' : locale);
}

/** Course card (06 §2.5): cover 16:9 (lazy), title, instructor, level, duration, price. */
export async function CourseCard({ course, priority = false }: { course: Card; priority?: boolean }) {
  const t = await getTranslations();
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-md border border-line bg-surface">
      <div className="aspect-video bg-sunken">
        {course.coverUrl !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed object-storage URLs; the derivative is already web-sized
          <img
            src={course.coverUrl}
            alt=""
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            width={640}
            height={360}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted" aria-hidden="true">
            <BookOpen className="size-8" strokeWidth={1.25} />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className="text-h3">
          <NextLink href={`/c/${course.slug}`} className="text-ink no-underline hover:underline">
            {course.title}
          </NextLink>
        </h3>
        {course.instructor.name !== '' ? (
          <p className="text-body-sm text-muted">{t('catalogue.by', { name: course.instructor.name })}</p>
        ) : null}
        <p className="text-caption text-subtle">
          {t(`catalogue.levels.${course.level}`)} · {t('common.lessons', { count: course.lessonCount })}
          {course.durationSeconds > 0 ? ` · ${await formatDuration(course.durationSeconds)}` : ''}
        </p>
        <p className="tabular mt-auto pt-2 text-label text-ink">
          {await formatPrice(course.priceMinor, course.currency)}
        </p>
      </div>
    </article>
  );
}

export async function CourseGrid({ courses }: { courses: Card[] }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {courses.map((course, index) => (
        <li key={course.slug}>
          <CourseCard course={course} priority={index < 2} />
        </li>
      ))}
    </ul>
  );
}
