import { StatePanel } from '@studyhub/ui';
import { getLocale, getTranslations } from 'next-intl/server';

import { PublicFrame } from '../../../../components/public-frame';
import { currentTenant, getTerms } from '../../../../lib/tenant';

/** S-P01 Home: the public shell. The search-first catalogue arrives with M5. */
export default async function TenantHomePage() {
  const tenant = await currentTenant();
  if (tenant === null) return null; // the layout has already resolved the school
  const locale = await getLocale();
  const t = await getTranslations('public.home');
  const terms = await getTerms(tenant, locale);
  const school = tenant.branding.displayName;
  return (
    <PublicFrame tenant={tenant}>
      <section className="flex flex-col gap-2 py-6">
        <h1 className="text-display" data-testid="tenant-name">
          {school}
        </h1>
        <p className="text-h3 font-normal text-ink">{t('title')}</p>
        <p className="max-w-reading text-body-lg text-muted">{t('subtitle', { ...terms, school })}</p>
        <div className="mt-4 h-[3px] w-24 rounded-full bg-accent" aria-hidden="true" />
      </section>
      <StatePanel
        kind="empty"
        title={t('emptyTitle', terms)}
        message={t('emptyMessage', { ...terms, school })}
      />
    </PublicFrame>
  );
}
