import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { TokenLanding } from '../../../../../components/auth-forms';
import { PublicFrame } from '../../../../../components/public-frame';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.switching'))('title') };
}

/** School switch landing (BR-68): exchanges the one-time hand-off for a session on this host. */
export default async function SwitchPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  return (
    <PublicFrame tenant={tenant}>
      <TokenLanding
        endpoint="/api/v1/auth/handoff"
        nextPath="/learn"
        texts={{
          working: t('auth.switching.title'),
          done: t('auth.switching.title'),
          failed: t('auth.switching.failed'),
          failedBody: '',
          continueLabel: t('common.signIn'),
          continueHref: '/sign-in',
        }}
      />
    </PublicFrame>
  );
}
