import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { TokenLanding } from '../../../../../components/auth-forms';
import { PublicFrame } from '../../../../../components/public-frame';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.verify'))('title') };
}

/** S-A04 Verify result. The token travels in the URL fragment and is POSTed once. */
export default async function VerifyEmailPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  return (
    <PublicFrame tenant={tenant}>
      <TokenLanding
        endpoint="/api/v1/auth/verify-email"
        nextPath="/learn"
        texts={{
          working: t('auth.verify.title'),
          done: t('auth.verify.done'),
          doneSignedIn: t('auth.verify.doneSignedIn'),
          failed: t('auth.verify.failed'),
          failedBody: t('auth.verify.failedBody'),
          continueLabel: t('common.signIn'),
          continueHref: '/sign-in',
        }}
      />
    </PublicFrame>
  );
}
