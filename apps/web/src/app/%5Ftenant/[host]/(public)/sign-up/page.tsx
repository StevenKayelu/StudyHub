import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getTranslations } from 'next-intl/server';

import { SignUpForm } from '../../../../../components/auth-forms';
import { AuthPage } from '../../../../../components/auth-page';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('common'))('createAccount') };
}

/** S-A02 Create account. The answer is the same whether or not the email has an account (BR-66). */
export default async function SignUpPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  return (
    <AuthPage
      tenant={tenant}
      title={t('auth.signUp.title', { school: tenant.branding.displayName })}
      footer={
        <p>
          {t('auth.signUp.haveAccount')} <NextLink href="/sign-in">{t('common.signIn')}</NextLink>
        </p>
      }
    >
      <SignUpForm
        texts={{
          errorSummary: t('common.errorSummary'),
          networkError: t('common.networkError'),
          name: t('common.name'),
          email: t('common.email'),
          password: t('common.password'),
          passwordHint: t('auth.signUp.passwordHint'),
          terms: t('auth.signUp.terms'),
          submit: t('auth.signUp.submit'),
          submitting: t('auth.signUp.submitting'),
        }}
      />
    </AuthPage>
  );
}
