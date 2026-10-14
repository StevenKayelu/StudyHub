import { myInstructorSchema } from '@studyhub/contracts';
import { Alert, buttonClasses } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { InstructorForm } from '../../../../../../components/instructor-form';
import { instructorFormTexts } from '../../../../../../components/instructor-texts';
import { PublicFrame } from '../../../../../../components/public-frame';
import { fetchContent } from '../../../../../../lib/content-api';
import { requireMember } from '../../../../../../lib/session';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('instructor'))('applicationTitle'), robots: { index: false } };
}

/** S-T01 Instructor application (F06): save a draft, submit, see the decision. */
export default async function ApplyPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const me = await requireMember();
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const mine = await fetchContent('/api/v1/me/instructor', myInstructorSchema);
  const isInstructor = me.allowedActions.includes('studio.access');
  return (
    <PublicFrame tenant={tenant} current="teach">
      <div className="flex flex-col gap-6 py-4">
        <h1 className="text-h1">{t('instructor.applicationTitle')}</h1>
        {isInstructor ? (
          <div className="flex flex-col items-start gap-3">
            <Alert tone="success" title={t('instructor.status.APPROVED')} />
            <NextLink href="/studio" className={buttonClasses('primary', 'md')}>
              {t('teach.goToStudio')}
            </NextLink>
          </div>
        ) : mine?.onboardingMode === 'INVITE_ONLY' ? (
          <Alert
            tone="info"
            title={t('teach.inviteOnly', { ...terms, school: tenant.branding.displayName })}
          />
        ) : mine?.profile?.status === 'APPROVED' ? (
          <Alert tone="success" title={t('instructor.approvedSignIn')} />
        ) : (
          <InstructorForm
            mode="apply"
            profile={mine?.profile ?? null}
            defaultName={me.user.displayName}
            texts={await instructorFormTexts()}
          />
        )}
      </div>
    </PublicFrame>
  );
}
