import { Card, StatCard } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { AdminFrame } from '../../../../components/workspace-frames';
import { currentTenant, getTerms } from '../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('admin'))('title') };
}

/** S-AD01 Overview: the tenant-admin shell, queues first. Access control arrives in M4. */
export default async function AdminOverviewPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('admin');
  const terms = await getTerms(tenant, await getLocale());
  return (
    <AdminFrame tenant={tenant} title={t('title')}>
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label={t('queues.applications', terms)} value="0" detail={t('queues.none')} />
        <StatCard label={t('queues.reviews', terms)} value="0" detail={t('queues.none')} />
        <StatCard label={t('queues.payments')} value="0" detail={t('queues.none')} />
      </div>
      <Card>
        <p className="text-body text-muted">{t('metricsEmpty')}</p>
      </Card>
    </AdminFrame>
  );
}
