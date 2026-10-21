import { Alert } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { SignInForm } from '../../../../../components/auth-forms';
import { AuthPage } from '../../../../../components/auth-page';
import { getMe, safeReturnTo, sessionReplaced } from '../../../../../lib/session';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('common'))('signIn') };
}

/** S-A01 Sign in (rev. 4): one account, any school where the person is a member (BR-65). */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);
  if ((await getMe()) !== null) redirect(returnTo);
  // Signed out because the account signed in on another device (single-device-learners.md).
  const replaced = params.reason === 'replaced' || (await sessionReplaced());
  const t = await getTranslations();
  const school = tenant.branding.displayName;
  return (
    <AuthPage
      tenant={tenant}
      title={t('auth.signIn.title', { school })}
      intro={t('auth.signIn.helper')}
      footer={
        <div className="flex flex-col gap-2">
          <NextLink href="/forgot-password">{t('auth.signIn.forgot')}</NextLink>
          <p>
            {t('auth.signIn.noAccount')} <NextLink href="/sign-up">{t('auth.signIn.create')}</NextLink>
          </p>
        </div>
      }
    >
      {replaced ? (
        <div data-testid="signed-in-elsewhere">
          <Alert tone="warning" role="status" title={t('auth.signIn.replacedTitle')}>
            {t('auth.signIn.replaced', { school })}
          </Alert>
        </div>
      ) : null}
      <SignInForm
        returnTo={returnTo}
        texts={{
          errorSummary: t('common.errorSummary'),
          networkError: t('common.networkError'),
          email: t('common.email'),
          password: t('common.password'),
          submit: t('auth.signIn.submit'),
          submitting: t('auth.signIn.submitting'),
          joinTitle: t('auth.signIn.joinTitle', { school }),
          joinBody: t('auth.signIn.joinBody', { school }),
          joinSubmit: t('auth.signIn.joinSubmit', { school }),
          joinCancel: t('auth.signIn.joinCancel'),
        }}
      />
    </AuthPage>
  );
}
