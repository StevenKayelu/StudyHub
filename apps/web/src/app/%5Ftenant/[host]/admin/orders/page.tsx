import { adminOrdersSchema, paymentExceptionsSchema } from '@studyhub/contracts';
import { buttonClasses, formatMoney, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { ORDER_BADGES } from '../../../../../components/order-badges';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchContent } from '../../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.admin.orders'))('title') };
}

type Search = Promise<Record<string, string | string[] | undefined>>;
const STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED'] as const;

/** S-AD04 Orders & payments, with the S-AD02 payment-exceptions queue as a second tab (F26 AC 3). */
export default async function AdminOrdersPage({ searchParams }: { searchParams: Search }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : undefined);
  const tab = one('tab') === 'exceptions' ? 'exceptions' : 'all';
  const status = STATUSES.find((s) => s === one('status'));
  const q = one('q')?.slice(0, 100);
  const t = await getTranslations();
  const format = await getFormatter();
  const locale = await getLocale();
  const terms = await getTerms(tenant, locale);
  const exceptions =
    (await fetchContent('/api/v1/admin/payment-exceptions', paymentExceptionsSchema))?.exceptions ?? [];
  const query = new URLSearchParams({
    ...(status !== undefined && { status }),
    ...(q !== undefined && q !== '' && { q }),
  });
  const orders =
    tab === 'all'
      ? ((await fetchContent(`/api/v1/admin/orders?${query.toString()}`, adminOrdersSchema))?.orders ?? [])
      : [];
  const money = (m: { amountMinor: number; currency: string }) =>
    formatMoney(m.amountMinor, m.currency, locale);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const tabClass = (current: boolean) =>
    `relative inline-flex min-h-11 items-center px-3 text-label no-underline ${current ? 'text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-full after:bg-accent' : 'text-muted'}`;

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/orders"
      title={t('commerce.admin.orders.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/orders', label: t('commerce.admin.orders.title') },
      ]}
    >
      <nav aria-label={t('commerce.admin.orders.title')} className="flex gap-2 border-b border-line">
        <NextLink
          href="/admin/orders"
          className={tabClass(tab === 'all')}
          aria-current={tab === 'all' ? 'page' : undefined}
        >
          {t('commerce.admin.orders.all')}
        </NextLink>
        <NextLink
          href="/admin/orders?tab=exceptions"
          className={tabClass(tab === 'exceptions')}
          aria-current={tab === 'exceptions' ? 'page' : undefined}
        >
          {t('commerce.admin.orders.exceptions')} ({exceptions.length})
        </NextLink>
      </nav>

      {tab === 'exceptions' ? (
        exceptions.length === 0 ? (
          <StatePanel kind="empty" title={t('commerce.admin.orders.noExceptions')} />
        ) : (
          <ul
            className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface"
            data-testid="exceptions"
          >
            {exceptions.map((e) => (
              <li key={e.paymentId} className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <NextLink href={`/admin/orders/${e.orderId}`} className="text-label">
                    {e.buyerName} · {e.courseTitle}
                  </NextLink>
                  <span className="text-caption text-muted">
                    {date(e.createdAt)} ·{' '}
                    {t(`commerce.admin.orders.reviewReasons.${e.reviewReason as 'AMOUNT_MISMATCH'}`)}
                  </span>
                </div>
                <span className="tabular text-body-sm">
                  {t('commerce.admin.orders.expected', { amount: money(e.amount) })}
                  {e.providerAmount !== null
                    ? ` · ${t('commerce.admin.orders.providerSaid', { amount: money(e.providerAmount) })}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <>
          <form className="flex flex-wrap items-end gap-3" method="get">
            <label className="flex flex-col gap-1 text-label">
              {t('commerce.admin.orders.status')}
              <select
                name="status"
                defaultValue={status ?? ''}
                className="min-h-11 rounded-md border border-strong bg-surface px-3"
              >
                <option value="">{t('commerce.admin.orders.any')}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`commerce.orderStatuses.${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-label">
              {t('commerce.admin.orders.search', terms)}
              <input
                name="q"
                defaultValue={q ?? ''}
                className="min-h-11 rounded-md border border-strong bg-surface px-3"
              />
            </label>
            <button type="submit" className={buttonClasses('secondary')}>
              {t('commerce.admin.orders.apply')}
            </button>
          </form>
          {orders.length === 0 ? (
            <StatePanel kind="empty" title={t('commerce.admin.orders.empty')} />
          ) : (
            <div className="overflow-x-auto rounded-md border border-line bg-surface">
              <table className="w-full text-body-sm" data-testid="orders">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="p-3 font-normal">{t('commerce.admin.orders.date')}</th>
                    <th className="p-3 font-normal">{t('commerce.admin.orders.buyer')}</th>
                    <th className="p-3 font-normal">{t('commerce.admin.orders.course', terms)}</th>
                    <th className="p-3 text-right font-normal">{t('commerce.admin.orders.total')}</th>
                    <th className="p-3 font-normal">{t('commerce.admin.orders.payment')}</th>
                    <th className="p-3 font-normal">{t('commerce.admin.orders.status')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td className="p-3">
                        <NextLink href={`/admin/orders/${order.id}`} className="text-label">
                          {date(order.createdAt)}
                        </NextLink>
                      </td>
                      <td className="p-3">{order.buyerName}</td>
                      <td className="p-3">
                        {t(`commerce.parts.${order.part}`, { title: order.courseTitle })}
                      </td>
                      <td className="tabular p-3 text-right">{money(order.total)}</td>
                      <td className="p-3">
                        {order.method !== null ? t(`commerce.methods.${order.method}`) : '—'}
                        {order.paymentStatus !== null
                          ? ` · ${t(`commerce.paymentStatuses.${order.paymentStatus}`)}`
                          : ''}
                      </td>
                      <td className="p-3">
                        <StatusBadge status={ORDER_BADGES[order.status]}>
                          {t(`commerce.orderStatuses.${order.status}`)}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </AdminFrame>
  );
}
