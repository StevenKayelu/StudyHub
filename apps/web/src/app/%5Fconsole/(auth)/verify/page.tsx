import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ConsoleVerifyForm } from '../../../../components/console-forms';

export const metadata: Metadata = { title: 'Two-step verification' };

/** S-C01 step 2 for enrolled staff: a TOTP or recovery code. */
export default async function ConsoleVerifyPage() {
  const t = await getTranslations();
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{t('console.verify.title')}</h1>
        <p className="text-body text-muted">{t('console.verify.body')}</p>
      </div>
      <ConsoleVerifyForm
        texts={{
          ...{ errorSummary: t('common.errorSummary'), networkError: t('common.networkError') },
          code: t('console.verify.code'),
          submit: t('console.verify.submit'),
          submitting: t('console.verify.submitting'),
        }}
      />
    </>
  );
}
