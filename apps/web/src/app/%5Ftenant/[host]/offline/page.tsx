import { StatePanel } from '@studyhub/ui';
import { getTranslations } from 'next-intl/server';

/** S-X03 Offline fallback, served by the service worker (PWA, later) when a page can't load. */
export default async function OfflinePage() {
  const t = await getTranslations('system.offline');
  return (
    <main id="content" className="flex min-h-dvh items-center justify-center">
      <StatePanel kind="offline" headingLevel={1} title={t('title')} message={t('message')} />
    </main>
  );
}
