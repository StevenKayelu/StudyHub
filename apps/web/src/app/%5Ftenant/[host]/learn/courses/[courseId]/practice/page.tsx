import { practiceSetupSchema } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { LearnFrame } from '../../../../../../../components/learn-frame';
import { PracticeSetupForm } from '../../../../../../../components/practice';
import { UUID } from '../../../../../../../lib/learn-api';
import { learnTexts } from '../../../../../../../lib/learn-texts';
import { apiGet } from '../../../../../../../lib/session';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('learn.practice'))('title'), robots: { index: false } };
}

/** S-L07 Practice setup (F22; only while the school has the practice feature, F40). */
export default async function PracticeSetupPage({ params }: { params: Promise<{ courseId: string }> }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const { courseId } = await params;
  if (!UUID.test(courseId)) notFound();
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const response = await apiGet(`/api/v1/learn/courses/${courseId}/practice`);
  if (response.status === 401)
    redirect(`/sign-in?returnTo=${encodeURIComponent(`/learn/courses/${courseId}/practice`)}`);
  if (response.status === 404) notFound();
  let content: React.ReactNode;
  if (response.status === 402) {
    // Deposit plans: practice draws on the whole question bank, so it opens with the balance.
    content = (
      <StatePanel
        kind="permission"
        headingLevel={2}
        title={t('learn.player.practiceLocked')}
        message={t('learn.player.lockedElsewhereHint', terms)}
        actions={
          <NextLink href={`/learn/courses/${courseId}`} className={buttonClasses('primary')}>
            {t('learn.player.openCourse', terms)}
          </NextLink>
        }
      />
    );
  } else if (response.status === 403) {
    const problem = (await response.json()) as { code?: string };
    content = (
      <StatePanel
        kind="permission"
        headingLevel={2}
        title={
          problem.code === 'FEATURE_NOT_ENABLED'
            ? t('learn.practice.off')
            : problem.code === 'COURSE_NOT_OPEN'
              ? t('learn.player.practiceNotOpen', terms)
              : t('course.previewCta', terms)
        }
        {...(problem.code === 'COURSE_NOT_OPEN' && {
          actions: (
            <NextLink href={`/learn/courses/${courseId}`} className={buttonClasses('primary')}>
              {t('learn.player.openCourse', terms)}
            </NextLink>
          ),
        })}
      />
    );
  } else {
    const setup = practiceSetupSchema.parse(await response.json());
    content =
      setup.available === 0 ? (
        <StatePanel
          kind="empty"
          headingLevel={2}
          title={t('learn.practice.empty')}
          message={t('learn.practice.emptyMessage', terms)}
        />
      ) : (
        <PracticeSetupForm setup={setup} texts={await learnTexts(terms)} />
      );
  }
  return (
    <LearnFrame tenant={tenant} current="learning">
      <div className="flex max-w-reading flex-col gap-4">
        <NextLink href={`/learn/courses/${courseId}`} className="text-label">
          {t('learn.quiz.backToCourse', terms)}
        </NextLink>
        <h1 className="text-h1">{t('learn.practice.title')}</h1>
        <p className="text-muted">{t('learn.practice.intro', terms)}</p>
        {content}
      </div>
    </LearnFrame>
  );
}
