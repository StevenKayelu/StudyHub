import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ConsoleEnrol } from '../../../../components/console-forms';

export const metadata: Metadata = { title: 'Set up two-step verification' };

/** S-C01 first sign-in: mandatory TOTP enrolment, then recovery codes (shown once). */
export default async function ConsoleEnrolPage() {
  const t = await getTranslations();
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{t('console.enrol.title')}</h1>
        <p className="text-body text-muted">{t('console.enrol.body')}</p>
      </div>
      <ConsoleEnrol
        texts={{
          ...{ errorSummary: t('common.errorSummary'), networkError: t('common.networkError') },
          key: t('console.enrol.key'),
          link: t('console.enrol.link'),
          code: t('console.enrol.code'),
          submit: t('console.enrol.submit'),
          submitting: t('console.enrol.submitting'),
          recoveryTitle: t('console.enrol.recoveryTitle'),
          recoveryBody: t('console.enrol.recoveryBody'),
          done: t('console.enrol.done'),
        }}
      />
    </>
  );
}
