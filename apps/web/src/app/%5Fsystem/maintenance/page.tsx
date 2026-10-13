import { StatePanel } from '@studyhub/ui';
import { getTranslations } from 'next-intl/server';

/** S-X04 Maintenance. src/proxy.ts serves it with 503 and Retry-After while MAINTENANCE_MODE=on. */
export default async function MaintenancePage() {
  const t = await getTranslations('system.maintenance');
  return (
    <main id="content" className="flex min-h-dvh items-center justify-center">
      <StatePanel kind="maintenance" headingLevel={1} title={t('title')} message={t('message')} />
    </main>
  );
}
