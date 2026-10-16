import { consoleMetricsSchema, consoleOverviewSchema, tenantStatusSchema } from '@studyhub/contracts';
import { Card, formatMoney, StatCard, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { ConsoleFrame } from '../../../components/workspace-frames';
import { fetchConsole } from '../../../lib/admin-api';
import { getConsoleMe } from '../../../lib/session';

export const metadata: Metadata = { title: 'Overview' };

const HEALTH_BADGES = { OK: 'published', DEGRADED: 'attention', DOWN: 'failed', UNKNOWN: 'draft' } as const;

/** S-C02 Overview (F43): schools by status, work waiting, schools near limits, provider health. */
export default async function ConsoleOverviewPage() {
  const t = await getTranslations();
  const format = await getFormatter();
  const locale = await getLocale();
  const me = await getConsoleMe();
  const manager = me?.role === 'PLATFORM_OWNER' || me?.role === 'PLATFORM_OPERATOR';
  const [overview, metrics] = await Promise.all([
    fetchConsole('/overview', consoleOverviewSchema),
    manager ? fetchConsole('/metrics', consoleMetricsSchema) : Promise.resolve(null),
  ]);
  const o = (key: string) => t(`platformConsole.overview.${key}`);

  return (
    <ConsoleFrame title={t('platformConsole.nav.overview')}>
      {overview === null || overview === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="console-overview">
            <StatCard label={o('newThisMonth')} value={format.number(overview.newThisMonth)} />
            <StatCard
              label={o('pendingDomains')}
              value={format.number(overview.pendingDomainRequests)}
              {...(manager && {
                detail: <NextLink href="/domains">{t('platformConsole.nav.domains')}</NextLink>,
              })}
            />
            <StatCard
              label={o('pendingSupport')}
              value={format.number(overview.pendingSupportRequests)}
              detail={<NextLink href="/support">{t('platformConsole.nav.support')}</NextLink>}
            />
            <StatCard label={o('nearLimits')} value={format.number(overview.nearLimits.length)} />
          </div>
          <Card>
            <h2 className="text-h3">{o('byStatus')}</h2>
            <ul className="mt-3 flex flex-wrap gap-3">
              {tenantStatusSchema.options.map((status) => (
                <li key={status}>
                  <NextLink
                    href={`/tenants?status=${status}`}
                    className="flex items-center gap-2 rounded-md border border-line px-3 py-2 no-underline"
                  >
                    <span className="text-body-sm">{t(`platformConsole.statuses.${status}`)}</span>
                    <span className="text-label tabular">{overview.tenantsByStatus[status] ?? 0}</span>
                  </NextLink>
                </li>
              ))}
            </ul>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="text-h3">{o('nearLimits')}</h2>
              {overview.nearLimits.length === 0 ? (
                <p className="mt-2 text-body text-muted">{o('noneNear')}</p>
              ) : (
                <ul className="mt-2 flex flex-col divide-y divide-line">
                  {overview.nearLimits.map((item) => (
                    <li key={`${item.tenantId}-${item.meter}`} className="flex justify-between gap-3 py-2">
                      <NextLink href={`/tenants/${item.tenantId}`}>{item.name}</NextLink>
                      <span className="text-body-sm tabular">
                        {item.meter === 'storage' ? o('storage') : o('learners')} ·{' '}
                        {format.number(item.percent, { maximumFractionDigits: 0 })}%
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h2 className="text-h3">{o('providers')}</h2>
              <ul className="mt-2 flex flex-col divide-y divide-line">
                {overview.providers.map((provider) => (
                  <li
                    key={`${provider.kind}-${provider.name}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="flex flex-col">
                      <span className="text-label">{provider.name}</span>
                      {provider.detail !== null ? (
                        <span className="text-caption text-muted">{provider.detail}</span>
                      ) : null}
                    </span>
                    <StatusBadge status={HEALTH_BADGES[provider.status]}>
                      {t(`platformConsole.settings.healthStatuses.${provider.status}`)}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          {metrics !== null && metrics !== 'denied' ? (
            <Card>
              <h2 className="text-h3">{o('metrics')}</h2>
              <dl className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="console-metrics">
                {[
                  [t('platformConsole.nav.tenants'), format.number(metrics.tenants)],
                  [o('learners'), format.number(metrics.activeLearners)],
                  [o('instructors'), format.number(metrics.instructors)],
                  [
                    o('storage'),
                    `${format.number(metrics.storageBytes / 1024 ** 3, { maximumFractionDigits: 2 })} GB`,
                  ],
                  [
                    o('payments30'),
                    `${format.number(metrics.paymentsLast30Days.count)} · ${formatMoney(metrics.paymentsLast30Days.amountMinor, 'ZMW', locale)}`,
                  ],
                  [o('emails30'), format.number(metrics.emailsLast30Days)],
                ].map(([label, value]) => (
                  <div key={label} className="flex flex-col">
                    <dt className="text-body-sm text-muted">{label}</dt>
                    <dd className="text-h3 tabular">{value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          ) : null}
        </>
      )}
    </ConsoleFrame>
  );
}
