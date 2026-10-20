import { quizIntroSchema } from '@studyhub/contracts';
import { buttonClasses, Card, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { cache } from 'react';

import { LearnFrame } from '../../../../../../components/learn-frame';
import { RichText } from '../../../../../../components/rich-text';
import { StartAttempt } from '../../../../../../components/start-attempt';
import { fetchGated, UUID } from '../../../../../../lib/learn-api';
import { learnTexts } from '../../../../../../lib/learn-texts';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

type Params = Promise<{ quizId: string }>;

const load = cache(async (quizId: string) => {
  if (!UUID.test(quizId)) notFound();
  const intro = await fetchGated(`/api/v1/learn/quizzes/${quizId}`, quizIntroSchema);
  if (intro === null) notFound();
  return intro;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const intro = await load((await params).quizId);
  return {
    title:
      intro === 'locked' || 'balanceCourseId' in intro
        ? (await getTranslations('learn'))('title')
        : intro.quiz.title,
    robots: { index: false },
  };
}

const clock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** S-L04 Quiz intro: the rules, availability, previous attempts, then Start or Resume. */
export default async function QuizIntroPage({ params }: { params: Params }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const intro = await load((await params).quizId);
  const t = await getTranslations();
  const format = await getFormatter();
  const terms = await getTerms(tenant, await getLocale());
  if (intro === 'locked') {
    return (
      <LearnFrame tenant={tenant} current="learning">
        <StatePanel kind="permission" headingLevel={1} title={t('course.previewCta', terms)} />
      </LearnFrame>
    );
  }
  if ('balanceCourseId' in intro) {
    // Deposit plans: a quiz outside the lessons the deposit opened (decision 2).
    return (
      <LearnFrame tenant={tenant} current="learning">
        <StatePanel
          kind="permission"
          headingLevel={1}
          title={t('learn.player.quizLocked')}
          message={t('learn.player.lockedElsewhereHint', terms)}
          actions={
            intro.balanceCourseId === '' ? undefined : (
              <NextLink href={`/learn/courses/${intro.balanceCourseId}`} className={buttonClasses('primary')}>
                {t('learn.player.openCourse', terms)}
              </NextLink>
            )
          }
        />
      </LearnFrame>
    );
  }
  const { quiz } = intro;
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const rules = [
    t('learn.quiz.questions', { count: quiz.questionCount }),
    ...(quiz.totalPoints > 0 ? [t('learn.quiz.totalPoints', { count: quiz.totalPoints })] : []),
    quiz.timeLimitSeconds === null
      ? t('learn.quiz.noTimeLimit')
      : t('learn.quiz.timeLimit', { minutes: Math.round(quiz.timeLimitSeconds / 60) }),
    quiz.attemptsAllowed === null
      ? t('learn.quiz.attemptsUnlimited', { used: intro.attemptsUsed })
      : t('learn.quiz.attempts', { used: intro.attemptsUsed, allowed: quiz.attemptsAllowed }),
    ...(quiz.passMarkPercent !== null ? [t('learn.quiz.passMark', { percent: quiz.passMarkPercent })] : []),
    t('learn.quiz.feedback', {
      policy: t(`assessment.feedbackPolicies.${quiz.feedbackPolicy}`).toLowerCase(),
    }),
    ...(quiz.opensAt !== null ? [t('learn.quiz.opens', { date: date(quiz.opensAt) })] : []),
    ...(quiz.closesAt !== null ? [t('learn.quiz.closes', { date: date(quiz.closesAt) })] : []),
  ];
  const texts = await learnTexts(terms);
  const left =
    intro.inProgress !== null && intro.inProgress.deadlineAt !== null
      ? new Date(intro.inProgress.deadlineAt).getTime() - new Date(intro.serverNow).getTime()
      : null;
  return (
    <LearnFrame tenant={tenant} current="learning">
      <div className="flex max-w-reading flex-col gap-6">
        <NextLink href={`/learn/courses/${quiz.courseId}`} className="text-label">
          {t('learn.quiz.backToCourse', terms)}
        </NextLink>
        <h1 className="text-h1">{quiz.title}</h1>
        {quiz.instructions !== null ? <RichText doc={quiz.instructions} /> : null}
        <Card className="flex flex-col gap-2 p-5">
          <h2 className="text-h3">{t('learn.quiz.rules')}</h2>
          <ul className="list-disc ps-5">
            {rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </Card>
        {intro.inProgress !== null ? (
          <NextLink
            href={`/learn/attempts/${intro.inProgress.id}`}
            className={`${buttonClasses('primary')} self-start`}
            data-testid="resume-attempt"
          >
            {left === null ? t('learn.quiz.resume') : t('learn.quiz.resumeLeft', { time: clock(left) })}
          </NextLink>
        ) : intro.blocked !== null ? (
          <p className="text-body-lg" data-testid="quiz-blocked">
            {t(`learn.quiz.blocked.${intro.blocked}`)}
          </p>
        ) : (
          <StartAttempt
            quizId={quiz.id}
            label={t('learn.quiz.start')}
            timed={quiz.timeLimitSeconds !== null}
            texts={texts}
          />
        )}
        {intro.attempts.length > 0 ? (
          <section aria-labelledby="history" className="flex flex-col gap-2">
            <h2 id="history" className="text-h2">
              {t('learn.quiz.history')}
            </h2>
            <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
              {intro.attempts
                .filter((a) => a.status !== 'IN_PROGRESS')
                .map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 p-3">
                    <span className="flex-1">
                      {t('learn.quiz.attemptN', { number: a.attemptNumber ?? 0 })}
                      {a.submittedAt !== null ? (
                        <span className="text-caption text-muted"> · {date(a.submittedAt)}</span>
                      ) : null}
                    </span>
                    {a.status === 'NEEDS_REVIEW' ? (
                      <StatusBadge status="pending">
                        {t('assessment.attemptStatuses.NEEDS_REVIEW')}
                      </StatusBadge>
                    ) : a.percent !== null ? (
                      <span className="tabular">
                        {a.percent} %
                        {a.passed !== null
                          ? ` · ${a.passed ? t('assessment.passed') : t('assessment.failed')}`
                          : ''}
                      </span>
                    ) : null}
                    <NextLink href={`/learn/attempts/${a.id}/result`}>{t('learn.quiz.review')}</NextLink>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
      </div>
    </LearnFrame>
  );
}
