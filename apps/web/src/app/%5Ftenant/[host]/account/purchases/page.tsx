import { myOrdersSchema } from '@studyhub/contracts';
import { formatMoney, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { LearnFrame } from '../../../../../components/learn-frame';
import { ORDER_BADGES } from '../../../../../components/order-badges';
import { fetchContent } from '../../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.purchases'))('title'), robots: { index: false } };
}

/** S-L11 Purchases & receipts (F27). */
export default async function PurchasesPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const locale = await getLocale();
  const terms = await getTerms(tenant, locale);
  const list = await fetchContent('/api/v1/me/orders', myOrdersSchema);
  const orders = list?.orders ?? [];
  return (
    <LearnFrame tenant={tenant} current="account">
      <div className="flex flex-col gap-6">
        <NextLink href="/account" className="text-label">
          {t('account.title')}
        </NextLink>
        <h1 className="text-h1">{t('commerce.purchases.title')}</h1>
        {orders.length === 0 ? (
          <StatePanel kind="empty" title={t('commerce.purchases.empty')} />
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-surface">
            <table className="w-full text-body-sm" data-testid="purchases">
              <thead className="text-left text-muted">
                <tr>
                  <th className="p-3 font-normal">{t('commerce.purchases.date')}</th>
                  <th className="p-3 font-normal">{t('commerce.purchases.course', terms)}</th>
                  <th className="p-3 text-right font-normal">{t('commerce.purchases.amount')}</th>
                  <th className="p-3 font-normal">{t('commerce.purchases.status')}</th>
                  <th className="p-3 font-normal">
                    <span className="sr-only">{t('commerce.purchases.receipt')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td className="p-3">
                      {format.dateTime(new Date(order.createdAt), { dateStyle: 'medium' })}
                    </td>
                    <td className="p-3">{order.courseTitle}</td>
                    <td className="tabular p-3 text-right">
                      {formatMoney(order.total.amountMinor, order.total.currency, locale)}
                    </td>
                    <td className="p-3">
                      <StatusBadge status={ORDER_BADGES[order.status]}>
                        {t(`commerce.orderStatuses.${order.status}`)}
                      </StatusBadge>
                    </td>
                    <td className="p-3">
                      {order.receiptNumber !== null ? (
                        <NextLink href={`/account/purchases/${order.id}`} className="text-label">
                          {order.receiptNumber}
                        </NextLink>
                      ) : order.status === 'PENDING' ? (
                        <NextLink href={`/learn/orders/${order.id}`} className="text-label">
                          {t('commerce.purchases.open')}
                        </NextLink>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </LearnFrame>
  );
}
