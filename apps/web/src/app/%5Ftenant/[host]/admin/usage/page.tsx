import { adminUsageSchema, FEATURE_KEYS } from '@studyhub/contracts';
import { Card, ProgressLine, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchAdmin } from '../../../../../lib/admin-api';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.usage'))('title') };
}

const GB = 1024 ** 3;

/** S-AD17 Usage & plan (F47, BR-49): meters against the plan, daily usage, included features. */
export default async function UsagePage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const terms = await getTerms(tenant, await getLocale());
  const usage = await fetchAdmin('/api/v1/admin/usage', adminUsageSchema);
  const amount = (key: string, value: number) =>
    key === 'storage'
      ? `${format.number(value / GB, { maximumFractionDigits: 2 })} GB`
      : format.number(value);

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/usage"
      title={t('schoolAdmin.usage.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/usage', label: t('schoolAdmin.usage.title') },
      ]}
    >
      {usage === null || usage === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <>
          <p className="text-h3">{t('schoolAdmin.usage.plan', { name: usage.plan.name })}</p>
          <div className="grid gap-4 md:grid-cols-2" data-testid="meters">
            {usage.meters.map((meter) => (
              <Card key={meter.key}>
                <div className="flex flex-col gap-2" data-meter={meter.key} data-state={meter.state}>
                  <span className="text-label">{t(`schoolAdmin.usage.meters.${meter.key}`, terms)}</span>
                  <span className="tabular text-body">
                    {meter.limit === null
                      ? t('schoolAdmin.usage.unlimited', { used: amount(meter.key, meter.used) })
                      : t('schoolAdmin.usage.of', {
                          used: amount(meter.key, meter.used),
                          limit: amount(meter.key, meter.limit),
                        })}
                  </span>
                  {meter.percent !== null ? (
                    <ProgressLine
                      value={Math.min(100, meter.percent)}
                      max={100}
                      label={`${format.number(meter.percent, { maximumFractionDigits: 1 })}%`}
                    />
                  ) : null}
                  {meter.state !== 'OK' ? (
                    <span
                      className={
                        meter.state === 'FULL' ? 'text-body-sm text-danger' : 'text-body-sm text-warning'
                      }
                    >
                      {meter.state === 'FULL' ? t('schoolAdmin.usage.full') : t('schoolAdmin.usage.warn')}
                    </span>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
          <Card>
            <h2 className="text-h3">{t('schoolAdmin.usage.daily')}</h2>
            {usage.daily.length === 0 ? (
              <p className="mt-2 text-body text-muted">{t('schoolAdmin.usage.noUsage')}</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-body-sm">
                  <thead className="text-caption text-muted">
                    <tr>
                      <th scope="col" className="py-2 pe-4">
                        {t('schoolAdmin.usage.date')}
                      </th>
                      <th scope="col" className="py-2 pe-4 text-end">
                        {t('schoolAdmin.usage.meters.activeLearners')}
                      </th>
                      <th scope="col" className="py-2 pe-4 text-end">
                        {t('schoolAdmin.usage.meters.storage')}
                      </th>
                      <th scope="col" className="py-2 pe-4 text-end">
                        {t('schoolAdmin.usage.emails')}
                      </th>
                      <th scope="col" className="py-2 text-end">
                        {t('schoolAdmin.usage.payments')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="tabular divide-y divide-line">
                    {usage.daily.map((day) => (
                      <tr key={day.date}>
                        <th scope="row" className="py-2 pe-4 font-normal">
                          {day.date}
                        </th>
                        <td className="py-2 pe-4 text-end">{day.activeLearners}</td>
                        <td className="py-2 pe-4 text-end">{amount('storage', day.storageBytes)}</td>
                        <td className="py-2 pe-4 text-end">{day.emailsSent}</td>
                        <td className="py-2 text-end">{day.paymentsCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card>
            <h2 className="text-h3">{t('schoolAdmin.usage.features')}</h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {FEATURE_KEYS.filter((key) => usage.plan.features[key] === true).map((key) => (
                <li key={key} className="rounded-full bg-sunken px-3 py-1 text-body-sm">
                  {t(`schoolAdmin.features.names.${key}`)}
                </li>
              ))}
            </ul>
            {tenant.branding.supportEmail === null ? null : (
              <p className="mt-3 text-body-sm text-muted">{t('schoolAdmin.usage.changePlan')}</p>
            )}
          </Card>
        </>
      )}
    </AdminFrame>
  );
}
