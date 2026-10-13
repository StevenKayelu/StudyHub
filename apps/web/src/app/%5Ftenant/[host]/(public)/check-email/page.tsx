import { Alert } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AuthPage } from '../../../../../components/auth-page';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.checkEmail'))('title') };
}

/** S-A03 Check your email. Worded so it never confirms whether the email has an account. */
export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('auth.checkEmail');
  const email = (await searchParams).email;
  const address = typeof email === 'string' && email.length <= 254 ? email : null;
  return (
    <AuthPage tenant={tenant} title={t('title')}>
      <Alert tone="info" role="status">
        {address !== null ? t('body', { email: address }) : t('bodyNoEmail')}
      </Alert>
    </AuthPage>
  );
}
