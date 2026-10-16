import { statementSchema } from '@studyhub/contracts';
import { StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { STATEMENT_BADGES } from '../../../../../../components/order-badges';
import { PrintButton } from '../../../../../../components/print-button';
import { StatementLines } from '../../../../../../components/statement-lines';
import { AdminFrame } from '../../../../../../components/workspace-frames';
import { fetchAdmin } from '../../../../../../lib/admin-api';
import { currentTenant } from '../../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.billing'))('title') };
}

/** One platform statement (W8), printable (PROPOSED 9: HTML with a print stylesheet, no server PDF). */
export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const statement = await fetchAdmin(
    `/api/v1/admin/billing/statements/${encodeURIComponent(id)}`,
    statementSchema,
  );
  if (statement === null) notFound();
  const title =
    statement === 'denied'
      ? t('schoolAdmin.billing.title')
      : t('schoolAdmin.billing.statementTitle', { period: statement.period });
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/billing"
      title={title}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/billing', label: t('schoolAdmin.billing.title') },
        { href: `/admin/billing/${id}`, label: title },
      ]}
    >
      {statement === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <article className="flex max-w-reading flex-col gap-4" data-testid="statement">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-label">{tenant.branding.displayName}</p>
            <StatusBadge status={STATEMENT_BADGES[statement.status]}>
              {t(`schoolAdmin.billing.statuses.${statement.status}`)}
            </StatusBadge>
          </div>
          <StatementLines statement={statement} />
          <p className="text-body-sm text-muted">{t('schoolAdmin.billing.questions')}</p>
          <PrintButton label={t('schoolAdmin.billing.print')} />
        </article>
      )}
    </AdminFrame>
  );
}
