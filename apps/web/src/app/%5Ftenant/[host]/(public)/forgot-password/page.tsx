import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ForgotPasswordForm } from '../../../../../components/auth-forms';
import { AuthPage } from '../../../../../components/auth-page';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.forgot'))('title') };
}

/** S-A05 Forgot password: always the same confirmation, whatever the email. */
export default async function ForgotPasswordPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  return (
    <AuthPage tenant={tenant} title={t('auth.forgot.title')} intro={t('auth.forgot.body')}>
      <ForgotPasswordForm
        texts={{
          errorSummary: t('common.errorSummary'),
          networkError: t('common.networkError'),
          email: t('common.email'),
          submit: t('auth.forgot.submit'),
          submitting: t('auth.forgot.submitting'),
          sent: t('auth.forgot.sent'),
        }}
      />
    </AuthPage>
  );
}
