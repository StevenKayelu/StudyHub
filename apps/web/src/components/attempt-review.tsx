import 'server-only';

import type { AttemptResult } from '@studyhub/contracts';
import { Alert, Card, StatusBadge } from '@studyhub/ui';
import { CircleCheck, CircleX, Clock } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';

import type { Terms } from '../lib/tenant';
import { RichText } from './rich-text';

type Item = AttemptResult['items'][number];

function describe(item: Item, value: unknown, noAnswer: string): string {
  if (value === null || value === undefined) return noAnswer;
  const v = value as {
    optionIds?: string[];
    text?: string;
    number?: number;
    acceptedAnswers?: string[];
    value?: number | null;
    tolerance?: number;
  };
  if (v.optionIds !== undefined) {
    const chosen = item.question.options.filter((o) => v.optionIds!.includes(o.id)).map((o) => o.content);
    return chosen.length === 0 ? noAnswer : chosen.join(', ');
  }
  if (v.text !== undefined) return v.text.trim() === '' ? noAnswer : v.text;
  if (v.number !== undefined)
    return `${v.number}${item.question.unit !== undefined ? ` ${item.question.unit}` : ''}`;
  if (v.acceptedAnswers !== undefined) return v.acceptedAnswers.join(' / ');
  if (v.value !== undefined && v.value !== null) {
    return `${v.value}${v.tolerance ? ` ± ${v.tolerance}` : ''}${item.question.unit !== undefined ? ` ${item.question.unit}` : ''}`;
  }
  return noAnswer;
}

const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** S-L06 Result and review: score, verdict, time; then each question as the feedback policy allows (F21). */
export async function AttemptReview({ result, terms }: { result: AttemptResult; terms: Terms }) {
  const t = await getTranslations();
  const format = await getFormatter();
  const r = (key: string, values: Record<string, string | number> = {}) =>
    t(`learn.result.${key}`, { ...terms, ...values });
  const { visibility } = result;
  return (
    <div className="flex flex-col gap-6">
      <div data-testid="attempt-score">
        <Card className="flex flex-col gap-3 p-5">
          {visibility.score && result.score !== null ? (
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <p className="tabular text-display">{r('percent', { percent: result.percent ?? 0 })}</p>
              <p className="tabular text-h3 text-muted">
                {r('score', { score: result.score, max: result.maxScore ?? 0 })}
              </p>
              {result.passed !== null ? (
                <StatusBadge status={result.passed ? 'published' : 'failed'}>
                  {result.passed ? t('assessment.passed') : t('assessment.failed')}
                </StatusBadge>
              ) : null}
            </div>
          ) : (
            <p className="text-body-lg">{r('noScore')}</p>
          )}
          <p className="text-body-sm text-muted">
            {[
              result.attemptNumber !== null
                ? result.attemptsLeft !== null
                  ? r('attemptOf', {
                      number: result.attemptNumber,
                      allowed: result.attemptNumber + result.attemptsLeft,
                    })
                  : r('attemptNumber', { number: result.attemptNumber })
                : null,
              result.timeTakenSeconds !== null
                ? r('timeTaken', { time: minutes(result.timeTakenSeconds) })
                : null,
            ]
              .filter((x): x is string => x !== null)
              .join(' · ')}
          </p>
          {result.submitKind === 'AUTO' ? <p className="text-body-sm">{r('autoSubmitted')}</p> : null}
          {result.status === 'NEEDS_REVIEW' ? (
            <Alert tone="info">
              <span className="flex items-center gap-2">
                <Clock aria-hidden="true" className="size-4" />
                {r('beingMarked')}
              </span>
            </Alert>
          ) : null}
          {visibility.opensAt !== null ? (
            <Alert tone="info">
              {r('reviewOpens', {
                date: format.dateTime(new Date(visibility.opensAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </Alert>
          ) : null}
        </Card>
      </div>

      {visibility.details && result.items.length > 0 ? (
        <section aria-labelledby="review" className="flex flex-col gap-3">
          <h2 id="review" className="text-h2">
            {r('review')}
          </h2>
          <ol className="flex flex-col gap-3">
            {result.items.map((item) => {
              const manual = item.awardedPoints === null;
              return (
                <li key={item.id}>
                  <Card className="flex flex-col gap-2 p-4">
                    <div className="flex items-start gap-2">
                      {manual ? (
                        <Clock aria-hidden="true" className="mt-1 size-5 shrink-0 text-muted" />
                      ) : item.isCorrect ? (
                        <CircleCheck aria-hidden="true" className="mt-1 size-5 shrink-0 text-success" />
                      ) : (
                        <CircleX aria-hidden="true" className="mt-1 size-5 shrink-0 text-danger" />
                      )}
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <h3 className="sr-only">
                          {t('learn.runner.questionOf', {
                            number: item.position + 1,
                            total: result.items.length,
                          })}
                        </h3>
                        <RichText doc={item.question.stem} />
                        <p className="text-body-sm">
                          <span className="text-label">{r('yourAnswer')}: </span>
                          {describe(item, item.response, r('noAnswer'))}
                        </p>
                        {item.correct !== null &&
                        visibility.correctAnswers &&
                        item.question.type !== 'LONG_ANSWER' ? (
                          <p className="text-body-sm">
                            <span className="text-label">{r('correctAnswer')}: </span>
                            {describe(item, item.correct, '—')}
                          </p>
                        ) : null}
                        {item.explanation !== null && item.explanation !== undefined ? (
                          <div className="rounded-md bg-sunken p-3 text-body-sm">
                            <p className="text-label">{r('explanation')}</p>
                            <RichText doc={item.explanation} />
                          </div>
                        ) : null}
                        {item.graderComment !== null ? (
                          <p className="text-body-sm">
                            <span className="text-label">{r('comment')}: </span>
                            {item.graderComment}
                          </p>
                        ) : null}
                      </div>
                      <span className="tabular shrink-0 text-caption text-muted">
                        {manual
                          ? r('awaitingMark')
                          : r('awarded', { awarded: item.awardedPoints ?? 0, points: item.points })}
                      </span>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
