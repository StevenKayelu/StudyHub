import { attemptViewSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { QuizRunner } from '../../../../../../components/quiz-runner';
import { fetchLearning, UUID } from '../../../../../../lib/learn-api';
import { learnTexts } from '../../../../../../lib/learn-texts';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('learn.result'))('title'), robots: { index: false } };
}

/** S-L05 Focus mode: the attempt alone, without the app's navigation. */
export default async function AttemptPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  if (!UUID.test(attemptId)) notFound();
  const attempt = await fetchLearning(`/api/v1/learn/attempts/${attemptId}`, attemptViewSchema);
  if (attempt === null || attempt === 'locked') notFound();
  if (attempt.mode === 'PRACTICE') redirect(`/learn/practice/${attempt.id}`);
  if (attempt.status !== 'IN_PROGRESS') redirect(`/learn/attempts/${attempt.id}/result`);
  const terms = await getTerms(await currentTenant(), await getLocale());
  return (
    <QuizRunner
      attempt={attempt}
      texts={await learnTexts(terms)}
      introHref={`/learn/quizzes/${attempt.quizId}`}
    />
  );
}
