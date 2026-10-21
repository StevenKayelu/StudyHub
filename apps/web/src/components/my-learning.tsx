import 'server-only';

import type { MyLearning } from '@studyhub/contracts';
import { buttonClasses, Card, ProgressLine, StatusBadge } from '@studyhub/ui';
import { BookOpen } from 'lucide-react';
import NextLink from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

type Item = MyLearning['items'][number];

const resumeHref = (item: Item) =>
  item.resume === null
    ? `/learn/courses/${item.course.id}`
    : `/learn/courses/${item.course.id}/lessons/${item.resume.lessonId}`;

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

/** S-L01 Continue card: the last course and lesson, opening exactly there (F16 AC). */
export async function ContinueCard({ item }: { item: Item }) {
  const t = await getTranslations('learn');
  return (
    <div data-testid="continue-card">
      <Card className="flex flex-col gap-3 p-5">
        <p className="text-label text-muted">{t('continueTitle')}</p>
        <h2 className="text-h2">{item.course.title}</h2>
        {item.resume !== null ? (
          <p>
            {item.resume.lessonTitle}
            {item.resume.positionSeconds > 0 ? (
              <span className="text-muted">
                {' '}
                · {t('resumeAt', { time: clock(item.resume.positionSeconds) })}
              </span>
            ) : null}
          </p>
        ) : null}
        <ProgressLine
          value={item.progressPercent}
          max={100}
          label={t('progress', { percent: item.progressPercent })}
        />
        <NextLink href={resumeHref(item)} className={`${buttonClasses('primary')} self-start`}>
          {item.resume === null ? t('start') : t('resume')}
        </NextLink>
      </Card>
    </div>
  );
}

/** One enrolled course with its progress line. */
export async function EnrolledCourse({ item }: { item: Item }) {
  const t = await getTranslations('learn');
  const format = await getFormatter();
  const done = item.completedAt !== null;
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-md border border-line bg-surface">
      <div className="aspect-video bg-sunken">
        {item.course.coverUrl !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed object-storage URL
          <img
            src={item.course.coverUrl}
            alt=""
            loading="lazy"
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
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="text-h3">
          <NextLink href={resumeHref(item)} className="text-ink no-underline hover:underline">
            {item.course.title}
          </NextLink>
        </h3>
        {item.course.instructorName !== '' ? (
          <p className="text-body-sm text-muted">{item.course.instructorName}</p>
        ) : null}
        {item.lock !== null ? (
          <StatusBadge status="pending">
            {item.lock.opensAt === null
              ? t('notOpenYet')
              : t('opensOn', { date: format.dateTime(new Date(item.lock.opensAt), { dateStyle: 'medium' }) })}
          </StatusBadge>
        ) : null}
        <div className="mt-auto pt-2">
          <ProgressLine
            value={item.progressPercent}
            max={100}
            label={done ? t('completed') : t('progress', { percent: item.progressPercent })}
          />
        </div>
        {item.expiresAt !== null ? (
          <p className="text-caption text-muted">
            {t('accessUntil', { date: format.dateTime(new Date(item.expiresAt), { dateStyle: 'medium' }) })}
          </p>
        ) : null}
      </div>
    </article>
  );
}

export async function EnrolledGrid({ items }: { items: Item[] }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <li key={item.enrollmentId}>
          <EnrolledCourse item={item} />
        </li>
      ))}
    </ul>
  );
}
