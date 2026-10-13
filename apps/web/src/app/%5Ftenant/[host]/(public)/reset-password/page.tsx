import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ResetPasswordForm } from '../../../../../components/auth-forms';
import { AuthPage } from '../../../../../components/auth-page';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.reset'))('title') };
}

/** S-A05 Reset password (token in the URL fragment). */
export default async function ResetPasswordPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  return (
    <AuthPage tenant={tenant} title={t('auth.reset.title')}>
      <ResetPasswordForm
        texts={{
          errorSummary: t('common.errorSummary'),
          networkError: t('common.networkError'),
          newPassword: t('auth.reset.newPassword'),
          hint: t('auth.signUp.passwordHint'),
          submit: t('auth.reset.submit'),
          submitting: t('auth.reset.submitting'),
          done: t('auth.reset.done'),
          signIn: t('common.signIn'),
          invalid: t('auth.verify.failed'),
        }}
      />
    </AuthPage>
  );
}
