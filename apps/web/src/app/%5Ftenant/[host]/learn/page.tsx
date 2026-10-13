import { buttonClasses, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { LearnFrame } from '../../../../components/learn-frame';
import { currentTenant, getTerms } from '../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('learn'))('title') };
}

/** S-L01 My learning: the learner shell. Sign-in (M4) and enrolments (M6) fill it later. */
export default async function LearnHomePage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('learn');
  const terms = await getTerms(tenant, await getLocale());
  return (
    <LearnFrame tenant={tenant} current="home">
      <h1 className="text-h1">{t('title')}</h1>
      <StatePanel
        kind="empty"
        title={t('emptyTitle', terms)}
        message={t('emptyMessage', terms)}
        actions={
          <NextLink href="/browse" className={buttonClasses('primary')}>
            {t('browse', terms)}
          </NextLink>
        }
      />
    </LearnFrame>
  );
}
