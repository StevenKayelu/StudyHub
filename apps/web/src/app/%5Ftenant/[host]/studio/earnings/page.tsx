import { myEarningsSchema, payoutMethodsSchema } from '@studyhub/contracts';
import { buttonClasses, formatMoney, StatCard, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { LedgerTable } from '../../../../../components/ledger-table';
import { PayoutMethods } from '../../../../../components/payout-methods';
import { StudioFrame } from '../../../../../components/workspace-frames';
import { commerceTexts } from '../../../../../lib/commerce-texts';
import { apiGet } from '../../../../../lib/session';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.earnings'))('title') };
}

/** S-T11 Earnings and S-T12 payout methods (F29). Only where the school shares revenue. */
export default async function EarningsPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('commerce');
  const format = await getFormatter();
  const locale = await getLocale();
  const terms = await getTerms(tenant, locale);
  const frame = { tenant, current: '/studio/earnings', title: t('earnings.title') };
  const response = await apiGet('/api/v1/studio/earnings');
  if (response.status === 403) {
    return (
      <StudioFrame {...frame}>
        <StatePanel kind="empty" title={t('earnings.off')} message={t('earnings.offHint')} />
      </StudioFrame>
    );
  }
  if (!response.ok) throw new Error(`The API returned ${response.status} for /studio/earnings.`);
  const earnings = myEarningsSchema.parse(await response.json());
  const methods = payoutMethodsSchema.parse(await (await apiGet('/api/v1/me/payout-methods')).json()).methods;
  const money = (amount: number) => formatMoney(amount, earnings.currency, locale);
  const texts = await commerceTexts(terms);
  return (
    <StudioFrame {...frame}>
      <div className="grid gap-4 md:grid-cols-3" data-testid="earnings-balances">
        <StatCard label={t('earnings.pending')} value={money(earnings.balances.pending)} />
        <StatCard label={t('earnings.available')} value={money(earnings.balances.available)} />
        <StatCard label={t('earnings.paidThisYear')} value={money(earnings.balances.paidThisYear)} />
      </div>
      <p className="max-w-reading text-body-sm text-muted">
        {t('earnings.explainer', {
          days: earnings.refundWindowDays,
          percent: earnings.commissionBps / 100,
          schedule: t(`earnings.schedules.${earnings.payoutSchedule}`),
        })}
      </p>
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-h3">{t('earnings.statement')}</h2>
          <a href="/api/v1/studio/earnings.csv" className={buttonClasses('secondary', 'sm')} download>
            {t('earnings.csv')}
          </a>
        </div>
        {earnings.months.length === 0 ? (
          <p className="text-body-sm text-muted">{t('earnings.empty')}</p>
        ) : (
          earnings.months.map((month) => (
            <div key={month.month} className="flex flex-col gap-2">
              <h3 className="flex flex-wrap justify-between gap-2 text-label">
                <span>
                  {format.dateTime(new Date(`${month.month}-01T12:00:00Z`), {
                    month: 'long',
                    year: 'numeric',
                  })}
                </span>
                <span className="tabular">{money(month.net)}</span>
              </h3>
              <LedgerTable entries={month.entries} texts={texts} locale={locale} />
            </div>
          ))
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-h3">{t('earnings.payouts')}</h2>
        {earnings.payouts.length === 0 ? (
          <p className="text-body-sm text-muted">{t('earnings.noPayouts')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {earnings.payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap gap-3 p-3 text-body-sm">
                <span className="tabular text-label">{money(p.amount.amountMinor)}</span>
                <span>{format.dateTime(new Date(p.paidAt), { dateStyle: 'medium' })}</span>
                <span className="text-muted">
                  {t('earnings.reference')}: {p.externalReference}
                  {p.methodHint !== null ? ` · ${p.methodHint}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <PayoutMethods initial={methods} texts={texts} />
    </StudioFrame>
  );
}
