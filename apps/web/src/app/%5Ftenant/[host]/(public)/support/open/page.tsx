import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SupportOpen } from '../../../../../../components/support-open';

export const metadata: Metadata = { robots: { index: false } };

/** F44: platform staff land here from the console's "Open school" (one-time token in the fragment). */
export default async function SupportOpenPage() {
  const t = await getTranslations('schoolAdmin.supportOpen');
  return (
    <main id="content" className="flex min-h-dvh items-center justify-center p-4">
      <SupportOpen opening={t('opening')} failed={t('failed')} />
    </main>
  );
}
