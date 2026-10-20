import { receiptViewSchema } from '@studyhub/contracts';
import { Alert, Card, formatMoney } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { LearnFrame } from '../../../../../../components/learn-frame';
import { PrintButton } from '../../../../../../components/print-button';
import { fetchContent } from '../../../../../../lib/content-api';
import { UUID } from '../../../../../../lib/learn-api';
import { currentTenant } from '../../../../../../lib/tenant';

type Params = Promise<{ orderId: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.receipt'))('back'), robots: { index: false } };
}

/** F27 receipt (F48: the school is the seller). Printable; "Save as PDF" from the print dialog. */
export default async function ReceiptPage({ params }: { params: Params }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const { orderId } = await params;
  if (!UUID.test(orderId)) notFound();
  const receipt = await fetchContent(`/api/v1/me/orders/${orderId}/receipt`, receiptViewSchema);
  if (receipt === null) notFound();
  const t = await getTranslations('commerce');
  const format = await getFormatter();
  const locale = await getLocale();
  const money = (m: { amountMinor: number; currency: string }) =>
    formatMoney(m.amountMinor, m.currency, locale);
  return (
    <LearnFrame tenant={tenant} current="account">
      <div className="flex max-w-reading flex-col gap-4">
        <NextLink href="/account/purchases" className="text-label print:hidden">
          {t('receipt.back')}
        </NextLink>
        <Card className="flex flex-col gap-4 p-6" data-testid="receipt">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h1 className="text-h2">{t('receipt.title', { number: receipt.number })}</h1>
            <p className="text-body-sm text-muted">
              {t('receipt.issued', {
                date: format.dateTime(new Date(receipt.issuedAt), { dateStyle: 'long' }),
              })}
            </p>
          </div>
          {receipt.refunded ? <Alert tone="info">{t('receipt.refunded')}</Alert> : null}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h2 className="text-label text-muted">{t('receipt.seller')}</h2>
              <p>{receipt.seller.legalName ?? receipt.seller.name}</p>
              {receipt.seller.address !== null ? (
                <p className="whitespace-pre-line">{receipt.seller.address}</p>
              ) : null}
              {receipt.seller.taxId !== null ? (
                <p>{t('receipt.taxId', { id: receipt.seller.taxId })}</p>
              ) : null}
            </div>
            <div>
              <h2 className="text-label text-muted">{t('receipt.buyer')}</h2>
              <p>{receipt.buyer.name}</p>
              <p className="break-all">{receipt.buyer.email}</p>
            </div>
          </div>
          <table className="w-full text-body-sm">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-2 font-normal">{t('receipt.item')}</th>
                <th className="py-2 text-right font-normal">{t('receipt.amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line border-y border-line">
              {receipt.items.map((item) => (
                <tr key={item.title}>
                  <td className="py-2">{t(`parts.${item.part}`, { title: item.title })}</td>
                  <td className="tabular py-2 text-right">{money(item.unitPrice)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th className="py-2 text-left">{t('receipt.total')}</th>
                <td className="tabular py-2 text-right text-label">{money(receipt.total)}</td>
              </tr>
            </tfoot>
          </table>
          <p className="text-body-sm text-muted">
            {t('receipt.paidWith', {
              method: [
                t(`methods.${receipt.payment.method}`),
                receipt.payment.network !== null ? t(`networks.${receipt.payment.network}`) : null,
                receipt.payment.maskedMsisdn,
              ]
                .filter(Boolean)
                .join(' · '),
            })}
            <br />
            {t('receipt.reference', { reference: receipt.payment.reference })}
          </p>
        </Card>
        <PrintButton label={t('receipt.print')} />
      </div>
    </LearnFrame>
  );
}
