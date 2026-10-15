import { questionListSchema } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { RichText } from '../../../../../../../components/rich-text';
import { loadStudioCourse, StudioCourseFrame } from '../../../../../../../components/studio-course-frame';
import { fetchContent } from '../../../../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | undefined>>;

const FILTERS = ['q', 'type', 'difficulty', 'tag', 'status'] as const;
const field = 'h-11 rounded-md border border-strong bg-surface px-3 font-normal';

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const course = await loadStudioCourse((await params).id);
  return { title: `${(await getTranslations('studio.questions'))('title')}: ${course.title}` };
}

/** S-T05 Question bank: filters in the URL (work without JavaScript), list, "New question". */
export default async function QuestionsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const course = await loadStudioCourse((await params).id);
  const search = await searchParams;
  const t = await getTranslations();
  const terms = await getTerms(await currentTenant(), await getLocale());
  const query = new URLSearchParams();
  for (const key of FILTERS) {
    const value = search[key];
    if (value !== undefined && value !== '') query.set(key, value);
  }
  const bank = await fetchContent(
    `/api/v1/studio/courses/${course.id}/questions?${query.toString()}`,
    questionListSchema,
  );
  const items = bank?.items ?? [];
  const base = `/studio/courses/${course.id}/questions`;
  return (
    <StudioCourseFrame course={course} tab="questions">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-h2">{t('studio.questions.title')}</h2>
          <NextLink href={`${base}/new`} className={buttonClasses('primary')}>
            {t('studio.questions.new')}
          </NextLink>
        </div>
        <form method="get" action={base} role="search" className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-label">
            {t('studio.questions.search')}
            <input type="search" name="q" defaultValue={search.q ?? ''} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-label">
            {t('studio.questions.type')}
            <select name="type" defaultValue={search.type ?? ''} className={field}>
              <option value="">{t('studio.questions.anyType')}</option>
              {Object.entries(t.raw('assessment.questionTypes') as Record<string, string>).map(
                ([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-label">
            {t('studio.questions.difficulty')}
            <select name="difficulty" defaultValue={search.difficulty ?? ''} className={field}>
              <option value="">{t('studio.questions.anyDifficulty')}</option>
              {(['EASY', 'MEDIUM', 'HARD'] as const).map((d) => (
                <option key={d} value={d}>
                  {t(`assessment.difficulties.${d}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-label">
            {t('studio.questions.tags')}
            <select name="tag" defaultValue={search.tag ?? ''} className={field}>
              <option value="">{t('studio.questions.anyTag')}</option>
              {(bank?.tags ?? []).map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-body-sm">
            <input
              type="checkbox"
              name="status"
              value="ARCHIVED"
              defaultChecked={search.status === 'ARCHIVED'}
              className="size-5"
            />
            {t('studio.questions.showArchived')}
          </label>
          <button type="submit" className={buttonClasses('secondary')}>
            {t('studio.questions.apply')}
          </button>
        </form>
        {items.length === 0 ? (
          <StatePanel
            kind="empty"
            title={t('studio.questions.empty')}
            message={t('studio.questions.emptyMessage', terms)}
          />
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {items.map((question) => (
              <li key={question.id} className="flex flex-col gap-1 p-3">
                <NextLink href={`${base}/${question.id}`} className="text-label">
                  {question.stemText === '' ? <RichText doc={question.stem} /> : question.stemText}
                </NextLink>
                <span className="text-caption text-muted">
                  {[
                    t(`assessment.questionTypes.${question.type}`),
                    t(`assessment.difficulties.${question.difficulty}`),
                    t('assessment.points', { count: question.points }),
                    ...(question.tags.length > 0 ? [question.tags.join(', ')] : []),
                    t('studio.questions.usedIn', { count: question.usedInQuizzes }),
                    ...(question.status === 'ARCHIVED' ? [t('studio.questions.archived')] : []),
                  ].join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </StudioCourseFrame>
  );
}
