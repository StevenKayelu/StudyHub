import { attemptViewSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { LearnFrame } from '../../../../../../components/learn-frame';
import { PracticeRunner } from '../../../../../../components/practice';
import { fetchLearning, UUID } from '../../../../../../lib/learn-api';
import { learnTexts } from '../../../../../../lib/learn-texts';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('learn.practice'))('title'), robots: { index: false } };
}

/** S-L07 Practice session. */
export default async function PracticeSessionPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const { attemptId } = await params;
  if (!UUID.test(attemptId)) notFound();
  const attempt = await fetchLearning(`/api/v1/learn/attempts/${attemptId}`, attemptViewSchema);
  if (attempt === null || attempt === 'locked') notFound();
  if (attempt.mode !== 'PRACTICE') redirect(`/learn/attempts/${attempt.id}`);
  const t = await getTranslations('learn.practice');
  const terms = await getTerms(tenant, await getLocale());
  return (
    <LearnFrame tenant={tenant} current="learning">
      <div className="flex max-w-reading flex-col gap-4">
        <h1 className="text-h1">{t('title')}</h1>
        <PracticeRunner attempt={attempt} texts={await learnTexts(terms)} />
      </div>
    </LearnFrame>
  );
}
