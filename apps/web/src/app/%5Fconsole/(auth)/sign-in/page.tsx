import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ConsoleSignInForm } from '../../../../components/console-forms';

export const metadata: Metadata = { title: 'Sign in' };

/** S-C01 Console sign-in, step 1 (password). Step 2 is TOTP: enrol or verify. */
export default async function ConsoleSignInPage() {
  const t = await getTranslations();
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{t('console.signIn.title')}</h1>
        <p className="text-body text-muted">{t('console.signIn.helper')}</p>
      </div>
      <ConsoleSignInForm
        texts={{
          ...{ errorSummary: t('common.errorSummary'), networkError: t('common.networkError') },
          email: t('common.email'),
          password: t('common.password'),
          submit: t('console.signIn.submit'),
          submitting: t('console.signIn.submitting'),
        }}
      />
    </>
  );
}
