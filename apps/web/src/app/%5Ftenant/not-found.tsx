import { StatePanel } from '@studyhub/ui';
import { getTranslations } from 'next-intl/server';

/**
 * S-X06 Site not found: unknown, unverified or deleted hosts (BR-60). Platform-neutral: it never
 * names, styles or hints at any school.
 */
export default async function SiteNotFound() {
  const t = await getTranslations('system.siteNotFound');
  return (
    <main id="content" className="flex min-h-dvh items-center justify-center">
      {/* Metadata generation stops at notFound(); React hoists this into <head>. */}
      <title>{t('title')}</title>
      <StatePanel kind="not-found" headingLevel={1} title={t('title')} message={t('message')} />
    </main>
  );
}
