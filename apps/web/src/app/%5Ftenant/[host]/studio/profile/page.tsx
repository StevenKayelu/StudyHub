import { myInstructorSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { InstructorForm } from '../../../../../components/instructor-form';
import { instructorFormTexts } from '../../../../../components/instructor-texts';
import { StudioFrame } from '../../../../../components/workspace-frames';
import { fetchContent } from '../../../../../lib/content-api';
import { requireMember } from '../../../../../lib/session';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('studio.nav'))('profile') };
}

/** S-T12 Instructor profile: what learners see on the instructor page. */
export default async function StudioProfilePage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const me = await requireMember();
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const mine = await fetchContent('/api/v1/me/instructor', myInstructorSchema);
  return (
    <StudioFrame
      tenant={tenant}
      current="/studio/profile"
      title={t('instructor.profileTitle', terms)}
      breadcrumbs={[
        { href: '/studio', label: t('studio.home') },
        { href: '/studio/profile', label: t('studio.nav.profile') },
      ]}
    >
      <InstructorForm
        mode="profile"
        profile={mine?.profile ?? null}
        defaultName={me.user.displayName}
        texts={await instructorFormTexts()}
      />
    </StudioFrame>
  );
}
