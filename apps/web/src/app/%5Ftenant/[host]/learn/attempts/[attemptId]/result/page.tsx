import { attemptResultSchema } from '@studyhub/contracts';
import { buttonClasses } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { AttemptReview } from '../../../../../../../components/attempt-review';
import { LearnFrame } from '../../../../../../../components/learn-frame';
import { apiGet } from '../../../../../../../lib/session';
import { UUID } from '../../../../../../../lib/learn-api';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('learn.result'))('title'), robots: { index: false } };
}

/** S-L06 Result and review (the feedback policy decides what is shown, F21). */
export default async function AttemptResultPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const { attemptId } = await params;
  if (!UUID.test(attemptId)) notFound();
  const response = await apiGet(`/api/v1/learn/attempts/${attemptId}/result`);
  // Not submitted yet: back to the runner.
  if (response.status === 409) redirect(`/learn/attempts/${attemptId}`);
  if (response.status === 401)
    redirect(`/sign-in?returnTo=${encodeURIComponent(`/learn/attempts/${attemptId}/result`)}`);
  if (!response.ok) notFound();
  const result = attemptResultSchema.parse(await response.json());
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  return (
    <LearnFrame tenant={tenant} current="learning">
      <div className="flex max-w-reading flex-col gap-6">
        <p className="text-label text-muted">{result.courseTitle}</p>
        <h1 className="text-h1">{result.quizTitle}</h1>
        <AttemptReview result={result} terms={terms} />
        <div className="flex flex-wrap gap-3">
          {result.quizId !== null && (result.attemptsLeft === null || result.attemptsLeft > 0) ? (
            <NextLink href={`/learn/quizzes/${result.quizId}`} className={buttonClasses('primary')}>
              {t('learn.result.tryAgain')}
            </NextLink>
          ) : result.quizId !== null ? (
            <NextLink href={`/learn/quizzes/${result.quizId}`} className={buttonClasses('secondary')}>
              {t('learn.result.backToQuiz')}
            </NextLink>
          ) : null}
          <NextLink href={`/learn/courses/${result.courseId}`} className={buttonClasses('ghost')}>
            {t('learn.quiz.backToCourse', terms)}
          </NextLink>
        </div>
      </div>
    </LearnFrame>
  );
}
