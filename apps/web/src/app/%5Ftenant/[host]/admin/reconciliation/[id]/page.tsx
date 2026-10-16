import { type SettlementItemView, settlementDetailSchema } from '@studyhub/contracts';
import { Money, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../../../components/action-button';
import { AdminFrame } from '../../../../../../components/workspace-frames';
import { actionTexts, fetchAdmin } from '../../../../../../lib/admin-api';
import { currentTenant } from '../../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.reconciliation'))('title') };
}

/** One settlement report (W7): every difference with both amounts and its resolution. */
export default async function SettlementReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const locale = await getLocale();
  const texts = await actionTexts();
  const data = await fetchAdmin(
    `/api/v1/admin/reconciliation/settlements/${encodeURIComponent(id)}`,
    settlementDetailSchema,
  );
  if (data === null) notFound();
  const title =
    data === 'denied'
      ? t('schoolAdmin.reconciliation.title')
      : `${data.report.periodStart} – ${data.report.periodEnd}`;
  const amount = (item: SettlementItemView, value: number | null) =>
    value === null ? '—' : <Money amountMinor={value} currency={item.currency} locale={locale} />;
  const resolve = (item: SettlementItemView, action: 'RECHECK' | 'ACCEPT' | 'REFUND' | 'NOTE') => (
    <ActionButton
      key={action}
      label={t(`schoolAdmin.reconciliation.actions.${action}`)}
      method="POST"
      path={`/api/v1/admin/reconciliation/settlements/${id}/items/${item.id}/resolve`}
      body={{ action }}
      texts={texts}
      testId={`resolve-${action.toLowerCase()}`}
      {...(action === 'NOTE' && {
        confirm: {
          title: t('schoolAdmin.reconciliation.actions.NOTE'),
          confirmLabel: t('schoolAdmin.reconciliation.actions.NOTE'),
          extraField: { name: 'note', label: t('schoolAdmin.reconciliation.note'), required: true },
        },
      })}
    />
  );

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/reconciliation"
      title={title}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/reconciliation', label: t('schoolAdmin.reconciliation.title') },
        { href: `/admin/reconciliation/${id}`, label: title },
      ]}
    >
      {data === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <>
          <p className="text-body tabular" data-testid="settlement-summary">
            {data.report.error ??
              t('schoolAdmin.reconciliation.summary', {
                matched: data.report.matchedCount,
                mismatches: data.report.mismatchCount,
                unresolved: data.report.unresolvedCount,
              })}
          </p>
          {data.items.length === 0 ? (
            <StatePanel kind="empty" title={t('schoolAdmin.reconciliation.allResolved')} />
          ) : (
            <ul
              className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface"
              data-testid="settlement-items"
            >
              {data.items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-2 p-3"
                  data-item={item.reference}
                  data-kind={item.kind}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all text-label">
                      {t('schoolAdmin.reconciliation.reference')}: {item.reference}
                    </span>
                    <StatusBadge status={item.resolution === null ? 'attention' : 'published'}>
                      {item.resolution === null
                        ? t(`schoolAdmin.reconciliation.kinds.${item.kind}`)
                        : t(`schoolAdmin.reconciliation.resolutions.${item.resolution}`)}
                    </StatusBadge>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-body-sm">
                    <dt className="text-muted">{t('schoolAdmin.reconciliation.ours')}</dt>
                    <dd>{amount(item, item.localAmountMinor)}</dd>
                    <dt className="text-muted">{t('schoolAdmin.reconciliation.theirs')}</dt>
                    <dd>{amount(item, item.providerAmountMinor)}</dd>
                  </dl>
                  {item.note !== null ? <p className="text-body-sm text-muted">{item.note}</p> : null}
                  <div className="flex flex-wrap items-center gap-2">
                    {item.resolution === null
                      ? [
                          resolve(item, 'RECHECK'),
                          resolve(item, 'ACCEPT'),
                          ...(item.orderId !== null && item.kind !== 'MISSING_LOCAL'
                            ? [resolve(item, 'REFUND')]
                            : []),
                          resolve(item, 'NOTE'),
                        ]
                      : null}
                    {item.orderId !== null ? (
                      <NextLink href={`/admin/orders/${item.orderId}`} className="text-body-sm">
                        {t('schoolAdmin.reconciliation.openOrder')}
                      </NextLink>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </AdminFrame>
  );
}
