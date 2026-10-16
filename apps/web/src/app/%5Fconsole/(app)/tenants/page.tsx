import { consoleTenantListSchema, tenantStatusSchema } from '@studyhub/contracts';
import { Button, buttonClasses, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

import { TENANT_BADGES } from '../../../../components/order-badges';
import { ConsoleFrame } from '../../../../components/workspace-frames';
import { fetchConsole } from '../../../../lib/admin-api';
import { getConsoleMe } from '../../../../lib/session';

export const metadata: Metadata = { title: 'Schools' };

type Search = Promise<Record<string, string | string[] | undefined>>;
const field = 'min-h-11 rounded-md border border-strong bg-surface px-3';

/** S-C03 Schools: metadata and aggregates only (F43 AC 1), searchable by name or address. */
export default async function TenantsPage({ searchParams }: { searchParams: Search }) {
  const t = await getTranslations();
  const format = await getFormatter();
  const me = await getConsoleMe();
  const manager = me?.role === 'PLATFORM_OWNER' || me?.role === 'PLATFORM_OPERATOR';
  const params = await searchParams;
  const one = (key: string) =>
    typeof params[key] === 'string' ? (params[key] as string).trim().slice(0, 120) : '';
  const q = one('q');
  const status = tenantStatusSchema.safeParse(one('status')).data;
  const query = new URLSearchParams({ ...(q !== '' && { q }), ...(status !== undefined && { status }) });
  const data = await fetchConsole(`/tenants?${query.toString()}`, consoleTenantListSchema);
  const c = (key: string) => t(`platformConsole.tenants.columns.${key}`);

  return (
    <ConsoleFrame
      current="/tenants"
      title={t('platformConsole.tenants.title')}
      {...(manager && {
        headerActions: (
          <NextLink href="/tenants/new" className={buttonClasses('primary', 'md')}>
            {t('platformConsole.tenants.create')}
          </NextLink>
        ),
      })}
    >
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="flex flex-col gap-1 text-label">
          {t('platformConsole.tenants.search')}
          <input name="q" type="search" defaultValue={q} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-label">
          {c('status')}
          <select name="status" defaultValue={status ?? ''} className={field}>
            <option value="">{t('platformConsole.tenants.anyStatus')}</option>
            {tenantStatusSchema.options.map((value) => (
              <option key={value} value={value}>
                {t(`platformConsole.statuses.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          {t('platformConsole.tenants.filter')}
        </Button>
      </form>
      {data === null || data === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : data.tenants.length === 0 ? (
        <StatePanel kind="empty" title={t('platformConsole.tenants.none')} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full text-left text-body-sm" data-testid="console-tenants">
            <thead className="text-caption text-muted">
              <tr>
                <th scope="col" className="p-3">
                  {c('name')}
                </th>
                <th scope="col" className="p-3">
                  {c('status')}
                </th>
                <th scope="col" className="p-3">
                  {c('plan')}
                </th>
                <th scope="col" className="p-3 text-end">
                  {c('learners')}
                </th>
                <th scope="col" className="p-3 text-end">
                  {c('storage')}
                </th>
                <th scope="col" className="p-3">
                  {c('created')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.tenants.map((tenant) => (
                <tr key={tenant.id} data-tenant={tenant.slug}>
                  <th scope="row" className="p-3 font-normal">
                    <NextLink href={`/tenants/${tenant.id}`} className="text-label">
                      {tenant.name}
                    </NextLink>
                    <span className="block text-caption text-muted">{tenant.primaryHost ?? tenant.slug}</span>
                  </th>
                  <td className="p-3">
                    <StatusBadge status={TENANT_BADGES[tenant.status]}>
                      {t(`platformConsole.statuses.${tenant.status}`)}
                    </StatusBadge>
                  </td>
                  <td className="p-3">{tenant.planCode ?? t('platformConsole.tenants.noPlan')}</td>
                  <td className="p-3 text-end tabular">
                    {tenant.activeLearners === null ? '—' : format.number(tenant.activeLearners)}
                  </td>
                  <td className="p-3 text-end tabular">
                    {tenant.storagePercent === null
                      ? '—'
                      : `${format.number(tenant.storagePercent, { maximumFractionDigits: 0 })}%`}
                  </td>
                  <td className="p-3 tabular">
                    {format.dateTime(new Date(tenant.createdAt), { dateStyle: 'medium' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleFrame>
  );
}
