import { statementListSchema } from '@studyhub/contracts';
import { Money, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { STATEMENT_BADGES } from '../../../../../components/order-badges';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchAdmin } from '../../../../../lib/admin-api';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.billing'))('title') };
}

/** S-AD21 Billing (W8): issued platform statements for owners. Paid outside StudyHub (Q-TEN-4 a). */
export default async function BillingPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const locale = await getLocale();
  const data = await fetchAdmin('/api/v1/admin/billing/statements', statementListSchema);
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/billing"
      title={t('schoolAdmin.billing.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/billing', label: t('schoolAdmin.billing.title') },
      ]}
    >
      <p className="max-w-reading text-body text-muted">{t('schoolAdmin.billing.intro')}</p>
      {data === null || data === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : data.statements.length === 0 ? (
        <StatePanel kind="empty" title={t('schoolAdmin.billing.none')} />
      ) : (
        <ul
          className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface"
          data-testid="statements"
        >
          {data.statements.map((statement) => (
            <li
              key={statement.id}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
              data-statement={statement.period}
            >
              <span className="text-label tabular">{statement.period}</span>
              <div className="flex flex-wrap items-center gap-3">
                <Money amountMinor={statement.totalDueMinor} currency={statement.currency} locale={locale} />
                <StatusBadge status={STATEMENT_BADGES[statement.status]}>
                  {t(`schoolAdmin.billing.statuses.${statement.status}`)}
                </StatusBadge>
                <NextLink href={`/admin/billing/${statement.id}`} className="text-body-sm">
                  {t('schoolAdmin.billing.view')}
                </NextLink>
              </div>
            </li>
          ))}
        </ul>
      )}
    </AdminFrame>
  );
}
