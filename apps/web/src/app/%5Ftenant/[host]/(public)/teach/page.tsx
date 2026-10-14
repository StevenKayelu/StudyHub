import { myInstructorSchema } from '@studyhub/contracts';
import { Alert, buttonClasses, Card } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { PublicFrame } from '../../../../../components/public-frame';
import { fetchContent } from '../../../../../lib/content-api';
import { getMe } from '../../../../../lib/session';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await currentTenant();
  const terms = await getTerms(tenant, await getLocale());
  return { title: (await getTranslations('teach'))('title', terms) };
}

/** S-P05 Teach: how teaching here works, and the way in (apply, sign in, or Studio). */
export default async function TeachPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const school = tenant.branding.displayName;
  const me = await getMe();
  const mine = me === null ? null : await fetchContent('/api/v1/me/instructor', myInstructorSchema);
  const isInstructor = me?.allowedActions.includes('studio.access') === true;

  let action;
  if (isInstructor) {
    action = (
      <NextLink href="/studio" className={buttonClasses('primary', 'md')}>
        {t('teach.goToStudio')}
      </NextLink>
    );
  } else if (mine?.onboardingMode === 'INVITE_ONLY') {
    action = <Alert tone="info" title={t('teach.inviteOnly', { ...terms, school })} />;
  } else if (me === null) {
    action = (
      <NextLink href="/sign-in?returnTo=%2Fteach%2Fapply" className={buttonClasses('primary', 'md')}>
        {t('teach.signInToApply')}
      </NextLink>
    );
  } else {
    action = (
      <NextLink href="/teach/apply" className={buttonClasses('primary', 'md')}>
        {t('teach.apply')}
      </NextLink>
    );
  }

  return (
    <PublicFrame tenant={tenant} current="teach">
      <div className="flex max-w-reading flex-col gap-6 py-4">
        <header className="flex flex-col gap-2">
          <h1 className="text-h1">{t('teach.title', terms)}</h1>
          <p className="text-body-lg text-muted">{t('teach.intro', { school })}</p>
        </header>
        <Card>
          <h2 className="text-h3">{t('teach.steps')}</h2>
          <ol className="mt-3 flex list-decimal flex-col gap-2 ps-6">
            <li>{t('teach.step1')}</li>
            <li>{t('teach.step2')}</li>
            <li>{t('teach.step3', terms)}</li>
            <li>{t('teach.step4')}</li>
          </ol>
        </Card>
        <div>{action}</div>
      </div>
    </PublicFrame>
  );
}
