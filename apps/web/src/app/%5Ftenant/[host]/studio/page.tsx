import { Button, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { StudioFrame } from '../../../../components/workspace-frames';
import { currentTenant, getTerms } from '../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('studio'))('home') };
}

/** Studio home: the tutor shell. Access control arrives in M4, authoring in M5. */
export default async function StudioHomePage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('studio');
  const terms = await getTerms(tenant, await getLocale());
  return (
    <StudioFrame
      tenant={tenant}
      title={t('title', terms)}
      breadcrumbs={[
        { href: '/studio', label: t('home') },
        { href: '/studio/courses', label: t('title', terms) },
      ]}
      headerActions={
        <Button variant="primary" disabled>
          {t('newCourse', terms)}
        </Button>
      }
    >
      <StatePanel kind="empty" title={t('emptyTitle', terms)} message={t('emptyMessage')} />
    </StudioFrame>
  );
}
