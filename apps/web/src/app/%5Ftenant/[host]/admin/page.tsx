import { paymentExceptionsSchema } from '@studyhub/contracts';
import { Card, StatCard } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import NextLink from 'next/link';

import { AdminFrame } from '../../../../components/workspace-frames';
import { apiGet } from '../../../../lib/session';
import { currentTenant, getTerms } from '../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('admin'))('title') };
}

/** S-AD01 Overview: the tenant-admin shell, queues first (payment exceptions from M8). */
export default async function AdminOverviewPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('admin');
  const terms = await getTerms(tenant, await getLocale());
  // Payment exceptions (S-AD02, M8): the queue card links to the review list.
  const exceptions = await apiGet('/api/v1/admin/payment-exceptions').then(async (r) =>
    r.ok ? paymentExceptionsSchema.parse(await r.json()).exceptions.length : 0,
  );
  return (
    <AdminFrame tenant={tenant} title={t('title')}>
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label={t('queues.applications', terms)} value="0" detail={t('queues.none')} />
        <StatCard label={t('queues.reviews', terms)} value="0" detail={t('queues.none')} />
        <NextLink href="/admin/orders?tab=exceptions" className="no-underline" data-testid="exceptions-card">
          <StatCard
            label={t('queues.payments')}
            value={String(exceptions)}
            detail={exceptions === 0 ? t('queues.none') : undefined}
          />
        </NextLink>
      </div>
      <Card>
        <p className="text-body text-muted">{t('metricsEmpty')}</p>
      </Card>
    </AdminFrame>
  );
}
