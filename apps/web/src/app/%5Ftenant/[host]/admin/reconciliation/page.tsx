import { SETTLEMENT_CSV_HEADER, settlementListSchema } from '@studyhub/contracts';
import { Card, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

import { type ApiField, ApiForm } from '../../../../../components/api-form';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchAdmin, formTexts } from '../../../../../lib/admin-api';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.reconciliation'))('title') };
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * S-AD20 Payment reconciliation (W7, SHOULD): fetch the provider's transaction list or upload its
 * statement CSV for a range; each report lists the differences to resolve one by one.
 */
export default async function ReconciliationPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const data = await fetchAdmin('/api/v1/admin/reconciliation/settlements', settlementListSchema);
  const texts = await formTexts();
  const today = new Date();
  const range: ApiField[] = [
    {
      kind: 'date',
      name: 'from',
      label: t('schoolAdmin.reconciliation.from'),
      defaultValue: isoDay(new Date(today.getTime() - 7 * 86_400_000)),
      required: true,
    },
    {
      kind: 'date',
      name: 'to',
      label: t('schoolAdmin.reconciliation.to'),
      defaultValue: isoDay(today),
      required: true,
    },
  ];

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/reconciliation"
      title={t('schoolAdmin.reconciliation.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/reconciliation', label: t('schoolAdmin.reconciliation.title') },
      ]}
    >
      <p className="max-w-reading text-body text-muted">{t('schoolAdmin.reconciliation.intro')}</p>
      {data === null || data === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : !data.hasAccount ? (
        <StatePanel
          kind="empty"
          title={t('schoolAdmin.reconciliation.noAccount')}
          actions={
            <NextLink href="/admin/payments" className="text-body-sm">
              {t('admin.nav.payments')}
            </NextLink>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="text-h3">{t('schoolAdmin.reconciliation.fetch')}</h2>
              <div className="mt-3">
                {data.canFetch ? (
                  <ApiForm
                    method="POST"
                    path="/api/v1/admin/reconciliation/settlements"
                    body={{ source: 'API' }}
                    fields={range}
                    columns={2}
                    submitLabel={t('schoolAdmin.reconciliation.fetch')}
                    texts={texts}
                    then={{ navigate: '/admin/reconciliation/{id}' }}
                    testId="settlement-fetch"
                  />
                ) : (
                  <p className="text-body-sm text-muted">{t('schoolAdmin.reconciliation.noListApi')}</p>
                )}
              </div>
            </Card>
            <Card>
              <h2 className="text-h3">{t('schoolAdmin.reconciliation.upload')}</h2>
              <div className="mt-3">
                <ApiForm
                  method="POST"
                  path="/api/v1/admin/reconciliation/settlements"
                  body={{ source: 'CSV' }}
                  fields={[
                    ...range,
                    {
                      kind: 'file',
                      name: 'csv',
                      label: t('schoolAdmin.reconciliation.file'),
                      hint: t('schoolAdmin.reconciliation.template', { header: SETTLEMENT_CSV_HEADER }),
                      accept: '.csv,text/csv',
                      required: true,
                    },
                  ]}
                  columns={2}
                  submitLabel={t('schoolAdmin.reconciliation.upload')}
                  texts={texts}
                  then={{ navigate: '/admin/reconciliation/{id}' }}
                  testId="settlement-upload"
                />
              </div>
            </Card>
          </div>
          <Card>
            <h2 className="text-h3">{t('schoolAdmin.reconciliation.reports')}</h2>
            {data.reports.length === 0 ? (
              <p className="mt-2 text-body text-muted">{t('schoolAdmin.reconciliation.none')}</p>
            ) : (
              <ul className="mt-2 flex flex-col divide-y divide-line" data-testid="settlement-reports">
                {data.reports.map((report) => (
                  <li key={report.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <NextLink href={`/admin/reconciliation/${report.id}`} className="text-label">
                        {report.periodStart} – {report.periodEnd}
                      </NextLink>
                      <span className="text-caption text-muted">
                        {t(`schoolAdmin.reconciliation.sources.${report.source}`)} ·{' '}
                        {format.dateTime(new Date(report.createdAt), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </span>
                      <span className="text-body-sm tabular">
                        {report.error ??
                          t('schoolAdmin.reconciliation.summary', {
                            matched: report.matchedCount,
                            mismatches: report.mismatchCount,
                            unresolved: report.unresolvedCount,
                          })}
                      </span>
                    </div>
                    {report.status === 'READY' && report.unresolvedCount === 0 ? (
                      <StatusBadge status="published">
                        {t('schoolAdmin.reconciliation.allResolved')}
                      </StatusBadge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </AdminFrame>
  );
}
