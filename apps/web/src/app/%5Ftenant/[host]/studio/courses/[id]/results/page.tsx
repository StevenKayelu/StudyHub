import {
  gradingQueueSchema,
  quizAnalyticsSchema,
  quizListSchema,
  studioAttemptListSchema,
} from '@studyhub/contracts';
import { Card, SecondaryNav, StatCard, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { GradeForm } from '../../../../../../../components/grade-form';
import { RichText } from '../../../../../../../components/rich-text';
import { loadStudioCourse, StudioCourseFrame } from '../../../../../../../components/studio-course-frame';
import { fetchContent } from '../../../../../../../lib/content-api';
import { apiGet } from '../../../../../../../lib/session';
import { studioTexts } from '../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;
type Search = Promise<{ tab?: string; quizId?: string }>;

const TABS = ['attempts', 'grading', 'analytics'] as const;
type Tab = (typeof TABS)[number];

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const course = await loadStudioCourse((await params).id);
  return { title: `${(await getTranslations('studio.results'))('title')}: ${course.title}` };
}

/** S-T10 Results: attempts (assessed only, F22 AC 2), the grading queue (F20) and analytics (F23). */
export default async function ResultsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const course = await loadStudioCourse((await params).id);
  const search = await searchParams;
  const tab: Tab = TABS.includes(search.tab as Tab) ? (search.tab as Tab) : 'attempts';
  const t = await getTranslations();
  const format = await getFormatter();
  const terms = await getTerms(await currentTenant(), await getLocale());
  const quizzes =
    (await fetchContent(`/api/v1/studio/courses/${course.id}/quizzes`, quizListSchema))?.items ?? [];
  const quizId = quizzes.some((q) => q.id === search.quizId) ? search.quizId : undefined;
  const base = `/studio/courses/${course.id}/results`;
  const href = (next: Tab, quiz = quizId) =>
    `${base}?tab=${next}${quiz !== undefined ? `&quizId=${quiz}` : ''}`;
  const date = (iso: string | null) =>
    iso === null ? '—' : format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  let body: React.ReactNode;
  if (tab === 'attempts') {
    const list = await fetchContent(
      `/api/v1/studio/courses/${course.id}/attempts${quizId !== undefined ? `?quizId=${quizId}` : ''}`,
      studioAttemptListSchema,
    );
    const items = list?.items ?? [];
    body =
      items.length === 0 ? (
        <StatePanel kind="empty" title={t('studio.results.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full text-body-sm">
            <caption className="sr-only">{t('studio.results.attempts')}</caption>
            <thead className="border-b border-line text-label">
              <tr>
                {(['learner', 'quiz', 'attempt', 'submitted', 'score'] as const).map((col) => (
                  <th key={col} scope="col" className="p-3 text-start">
                    {t(`studio.results.${col}`)}
                  </th>
                ))}
                <th scope="col" className="p-3 text-start">
                  <span className="sr-only">{t('studio.results.viewAttempt')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((a) => (
                <tr key={a.id}>
                  <th scope="row" className="p-3 text-start font-normal">
                    {a.learnerName}
                  </th>
                  <td className="p-3">{a.quizTitle}</td>
                  <td className="tabular p-3">{a.attemptNumber}</td>
                  <td className="p-3">{date(a.submittedAt)}</td>
                  <td className="p-3">
                    {a.status === 'NEEDS_REVIEW' ? (
                      <StatusBadge status="attention">
                        {t('assessment.attemptStatuses.NEEDS_REVIEW')}
                      </StatusBadge>
                    ) : (
                      <span className="tabular">
                        {a.percent ?? 0} %{' '}
                        {a.passed !== null
                          ? a.passed
                            ? `· ${t('assessment.passed')}`
                            : `· ${t('assessment.failed')}`
                          : ''}
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    <NextLink href={`${base}/${a.id}`}>{t('studio.results.viewAttempt')}</NextLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  } else if (tab === 'grading') {
    const queue =
      (await fetchContent(`/api/v1/studio/courses/${course.id}/grading-queue`, gradingQueueSchema))?.items ??
      [];
    const texts = await studioTexts(terms);
    const first = queue[0];
    body =
      first === undefined ? (
        <StatePanel
          kind="empty"
          title={t('studio.results.gradingEmpty')}
          message={t('studio.results.gradingEmptyMessage')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-body-sm text-muted">
            {t('studio.results.gradingProgress', { count: queue.length })}
          </p>
          <Card className="flex flex-col gap-3 p-5">
            <p className="text-caption text-muted">
              {first.learnerName} · {first.quizTitle} · {date(first.submittedAt)}
            </p>
            <RichText doc={first.stem} />
            <div className="rounded-md bg-sunken p-3">
              <p className="text-label">{t('studio.results.response')}</p>
              <p className="whitespace-pre-line">{first.response}</p>
            </div>
            <GradeForm
              key={first.itemId}
              attemptId={first.attemptId}
              itemId={first.itemId}
              max={first.points}
              texts={texts}
            />
          </Card>
        </div>
      );
  } else {
    const selected = quizId ?? quizzes[0]?.id;
    const response =
      selected === undefined ? null : await apiGet(`/api/v1/studio/quizzes/${selected}/analytics`);
    if (response !== null && response.status === 403) {
      body = <StatePanel kind="permission" title={t('studio.results.analyticsOff')} />;
    } else if (response === null || !response.ok) {
      body = <StatePanel kind="empty" title={t('studio.results.noData')} />;
    } else {
      const data = quizAnalyticsSchema.parse(await response.json());
      const peak = Math.max(1, ...data.distribution);
      body =
        data.attempts === 0 ? (
          <StatePanel kind="empty" title={t('studio.results.noData')} />
        ) : (
          <div className="flex flex-col gap-4" data-testid="quiz-analytics">
            <div className="grid gap-3 sm:grid-cols-4">
              <StatCard label={t('studio.results.attempts')} value={String(data.attempts)} />
              <StatCard label={t('studio.results.average')} value={`${data.averagePercent ?? 0} %`} />
              <StatCard label={t('studio.results.median')} value={`${data.medianPercent ?? 0} %`} />
              <StatCard
                label={t('studio.results.passRate')}
                value={data.passRate === null ? '—' : `${data.passRate} %`}
              />
            </div>
            <Card className="flex flex-col gap-2 p-4">
              <h3 className="text-h3">{t('studio.results.distribution')}</h3>
              <ol className="flex flex-col gap-1">
                {data.distribution.map((count, band) => (
                  <li key={band} className="flex items-center gap-2 text-caption">
                    <span className="tabular w-20 text-muted">
                      {t('studio.results.band', { from: band * 10, to: band === 9 ? 100 : band * 10 + 9 })}
                    </span>
                    <span
                      className="h-3 rounded-sm bg-accent"
                      style={{ width: `${(count / peak) * 70}%` }}
                      aria-hidden="true"
                    />
                    <span className="tabular">{count}</span>
                  </li>
                ))}
              </ol>
            </Card>
            <Card className="flex flex-col gap-2 p-4">
              <h3 className="text-h3">{t('studio.results.perQuestion')}</h3>
              <ul className="flex flex-col divide-y divide-line">
                {data.questions.map((question) => (
                  <li key={question.questionId} className="flex flex-col gap-1 py-2">
                    <span className="text-label">{question.stemText}</span>
                    <span className="text-caption text-muted">
                      {question.correctRate === null
                        ? '—'
                        : t('studio.results.correctRate', { percent: question.correctRate })}
                    </span>
                    {question.options.length > 0 ? (
                      <ul className="flex flex-wrap gap-x-4 text-caption">
                        {question.options.map((o) => (
                          <li key={o.id} className={o.isCorrect ? 'text-success' : ''}>
                            {o.content}: {t('studio.results.picks', { count: o.picks })}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        );
    }
  }

  return (
    <StudioCourseFrame course={course} tab="results">
      <div className="flex flex-col gap-4">
        <SecondaryNav
          label={t('studio.results.title')}
          items={TABS.map((key) => ({
            href: href(key),
            label: t(`studio.results.${key}`),
            current: key === tab,
          }))}
        />
        {tab !== 'grading' && quizzes.length > 0 ? (
          <form method="get" action={base} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value={tab} />
            <label className="flex flex-col gap-1 text-label">
              {t('studio.results.quiz')}
              <select
                name="quizId"
                defaultValue={quizId ?? ''}
                className="h-11 rounded-md border border-strong bg-surface px-3 font-normal"
              >
                {tab === 'attempts' ? <option value="">{t('studio.results.allQuizzes')}</option> : null}
                {quizzes.map((quiz) => (
                  <option key={quiz.id} value={quiz.id}>
                    {quiz.title}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="h-11 rounded-md border border-strong px-4 text-label">
              {t('studio.questions.apply')}
            </button>
          </form>
        ) : null}
        {body}
      </div>
    </StudioCourseFrame>
  );
}
