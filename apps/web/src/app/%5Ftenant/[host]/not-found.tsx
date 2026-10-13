import { buttonClasses, StatePanel } from '@studyhub/ui';
import NextLink from 'next/link';
import { getTranslations } from 'next-intl/server';

import { PublicFrame } from '../../../components/public-frame';
import { currentTenant } from '../../../lib/tenant';

/** S-X01 Not found, inside the school's own shell and theme. */
export default async function SchoolNotFound() {
  const t = await getTranslations();
  const tenant = await currentTenant();
  const panel = (
    <>
      <title>{t('system.notFound.title')}</title>
      <StatePanel
        kind="not-found"
        headingLevel={1}
        title={t('system.notFound.title')}
        message={t('system.notFound.message')}
        actions={
          <NextLink href="/" className={buttonClasses('primary')}>
            {t('common.goHome')}
          </NextLink>
        }
      />
    </>
  );
  return tenant === null ? (
    <main id="content">{panel}</main>
  ) : (
    <PublicFrame tenant={tenant}>{panel}</PublicFrame>
  );
}
