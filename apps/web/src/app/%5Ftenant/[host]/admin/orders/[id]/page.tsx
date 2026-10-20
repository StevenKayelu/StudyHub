import { adminOrderDetailSchema } from '@studyhub/contracts';
import { Card, formatMoney, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { LedgerTable } from '../../../../../../components/ledger-table';
import { OrderActions } from '../../../../../../components/order-admin';
import { ORDER_BADGES } from '../../../../../../components/order-badges';
import { AdminFrame } from '../../../../../../components/workspace-frames';
import { commerceTexts } from '../../../../../../lib/commerce-texts';
import { fetchContent } from '../../../../../../lib/content-api';
import { UUID } from '../../../../../../lib/learn-api';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.admin.orders'))('title') };
}

/** S-AD04 order detail: timeline, ledger lines and actions (refund, re-check, accept). */
export default async function AdminOrderPage({ params }: { params: Params }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const detail = await fetchContent(`/api/v1/admin/orders/${id}`, adminOrderDetailSchema);
  if (detail === null) notFound();
  const t = await getTranslations();
  const format = await getFormatter();
  const locale = await getLocale();
  const texts = await commerceTexts(await getTerms(tenant, locale));
  const money = (m: { amountMinor: number; currency: string }) =>
    formatMoney(m.amountMinor, m.currency, locale);
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'medium' });
  const { order } = detail;

  const timeline = [
    { at: order.createdAt, text: t('commerce.admin.orders.created') },
    ...detail.payments.flatMap((p) => [
      {
        at: p.createdAt,
        text: `${t('commerce.admin.orders.paymentStarted', { method: t(`commerce.methods.${p.method}`) })}${
          p.maskedMsisdn !== null ? ` (${p.maskedMsisdn})` : ''
        } · ${t(`commerce.paymentStatuses.${p.status}`)}${
          p.failureCode !== null ? ` · ${p.failureCode}` : ''
        }${p.reviewReason !== null ? ` · ${t(`commerce.admin.orders.reviewReasons.${p.reviewReason as 'AMOUNT_MISMATCH'}`)}` : ''}${
          p.providerAmount !== null
            ? ` · ${t('commerce.admin.orders.providerSaid', { amount: money(p.providerAmount) })}`
            : ''
        }`,
      },
      ...(p.confirmedAt !== null ? [{ at: p.confirmedAt, text: t('commerce.admin.orders.confirmed') }] : []),
    ]),
    ...detail.events.map((e) => ({
      at: e.receivedAt,
      text: t('commerce.admin.orders.eventReceived', { type: e.type }),
    })),
    ...detail.refunds.map((r) => ({
      at: r.createdAt,
      text: `${t('commerce.admin.orders.refundRecorded', {
        mode: t(`commerce.admin.orders.refundModes.${r.mode}`),
        status: r.status,
      })} · ${money(r.amount)} · ${r.reason}${r.reference !== null ? ` · ${r.reference}` : ''}`,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/orders"
      title={`${t(`commerce.parts.${order.part}`, { title: order.courseTitle })} · ${order.buyerName}`}
      breadcrumbs={[
        { href: '/admin/orders', label: t('commerce.admin.orders.title') },
        { href: `/admin/orders/${order.id}`, label: order.receiptNumber ?? order.id.slice(0, 8) },
      ]}
    >
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-6">
          <Card className="flex flex-wrap items-center gap-3">
            <StatusBadge status={ORDER_BADGES[order.status]}>
              {t(`commerce.orderStatuses.${order.status}`)}
            </StatusBadge>
            <span className="tabular text-h3">{money(order.total)}</span>
            <span className="text-body-sm text-muted break-all">{order.buyerEmail}</span>
            {order.enrollmentStatus !== null ? (
              <span className="text-body-sm">
                {t('commerce.admin.orders.access', {
                  status: t(`commerce.admin.orders.accessStatuses.${order.enrollmentStatus}`),
                  percent: order.progressPercent ?? 0,
                })}
              </span>
            ) : null}
          </Card>
          <section className="flex flex-col gap-2">
            <h2 className="text-h3">{t('commerce.admin.orders.timeline')}</h2>
            <ol className="flex flex-col gap-2 border-s-2 border-line ps-4" data-testid="order-timeline">
              {timeline.map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="text-body-sm">
                  <span className="text-muted">{date(entry.at)}</span> · {entry.text}
                </li>
              ))}
            </ol>
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="text-h3">{t('commerce.admin.orders.ledger')}</h2>
            {detail.ledger.length === 0 ? (
              <p className="text-body-sm text-muted">{t('commerce.admin.orders.noLedger')}</p>
            ) : (
              <LedgerTable entries={detail.ledger} texts={texts} locale={locale} />
            )}
          </section>
        </div>
        <OrderActions detail={detail} texts={texts} amountLabel={money(order.total)} />
      </div>
    </AdminFrame>
  );
}
