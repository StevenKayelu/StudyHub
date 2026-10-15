import { adminEarningsSchema, payoutsSchema } from '@studyhub/contracts';
import { formatMoney, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { AdminFrame } from '../../../../../components/workspace-frames';
import { apiGet } from '../../../../../lib/session';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.admin.payouts'))('title') };
}

/** S-AD05 Earnings & payouts: instructors with balances, then a payout run per instructor (W3). */
export default async function AdminPayoutsPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('commerce.admin.payouts');
  const format = await getFormatter();
  const locale = await getLocale();
  const frame = { tenant, current: '/admin/payouts', title: t('title') };
  const response = await apiGet('/api/v1/admin/earnings');
  if (response.status === 403) {
    return (
      <AdminFrame {...frame}>
        <StatePanel kind="empty" title={t('off')} message={t('offHint')} />
      </AdminFrame>
    );
  }
  if (!response.ok) throw new Error(`The API returned ${response.status} for /admin/earnings.`);
  const { instructors } = adminEarningsSchema.parse(await response.json());
  const history = payoutsSchema.parse(await (await apiGet('/api/v1/admin/payouts')).json()).payouts;
  const money = (amount: number, currency: string) => formatMoney(amount, currency, locale);
  return (
    <AdminFrame {...frame}>
      <section className="flex flex-col gap-2">
        <h2 className="text-h3">{t('instructors')}</h2>
        {instructors.length === 0 ? (
          <StatePanel kind="empty" title={t('empty')} />
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-surface">
            <table className="w-full text-body-sm" data-testid="instructor-balances">
              <thead className="text-left text-muted">
                <tr>
                  <th className="p-3 font-normal">{t('instructors')}</th>
                  <th className="p-3 text-right font-normal">{t('pending')}</th>
                  <th className="p-3 text-right font-normal">{t('available')}</th>
                  <th className="p-3 text-right font-normal">{t('paid')}</th>
                  <th className="p-3 font-normal">{t('method')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {instructors.map((i) => (
                  <tr key={i.membershipId}>
                    <td className="p-3">
                      <NextLink href={`/admin/payouts/${i.membershipId}`} className="text-label">
                        {i.name}
                      </NextLink>
                    </td>
                    <td className="tabular p-3 text-right">{money(i.pending, i.currency)}</td>
                    <td className="tabular p-3 text-right text-label">{money(i.available, i.currency)}</td>
                    <td className="tabular p-3 text-right">{money(i.paid, i.currency)}</td>
                    <td className="p-3">{i.payoutMethodHint ?? t('noMethod')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-h3">{t('history')}</h2>
        {history.length === 0 ? (
          <p className="text-body-sm text-muted">{t('noHistory')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {history.map((p) => (
              <li key={p.id} className="flex flex-wrap gap-3 p-3 text-body-sm">
                <span className="text-label">{p.instructorName}</span>
                <span className="tabular">{money(p.amount.amountMinor, p.amount.currency)}</span>
                <span>{format.dateTime(new Date(p.paidAt), { dateStyle: 'medium' })}</span>
                <span className="text-muted">
                  {p.externalReference} · {t('entries', { count: p.entryCount })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AdminFrame>
  );
}
