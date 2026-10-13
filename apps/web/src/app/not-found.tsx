import { StatePanel } from '@studyhub/ui';
import { getTranslations } from 'next-intl/server';

/** Not found on the platform and console hosts (school hosts use their own S-X01 page). */
export default async function PlatformNotFound() {
  const t = await getTranslations('system.notFound');
  return (
    <main id="content" className="flex min-h-dvh items-center justify-center">
      <title>{t('title')}</title>
      <StatePanel kind="not-found" headingLevel={1} title={t('title')} message={t('message')} />
    </main>
  );
}
