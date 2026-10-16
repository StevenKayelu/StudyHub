import 'server-only';

import type { Statement } from '@studyhub/contracts';
import { Money } from '@studyhub/ui';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

/** The statement arithmetic (BR-63): fee + commission × (sales − refunds) = total. */
export async function StatementLines({ statement }: { statement: Statement }) {
  const t = await getTranslations('schoolAdmin.billing');
  const locale = await getLocale();
  const format = await getFormatter();
  const money = (amount: number) => (
    <Money amountMinor={amount} currency={statement.currency} locale={locale} />
  );
  return (
    <>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 rounded-md border border-line bg-surface p-4 text-body">
        <dt>{t('subscription')}</dt>
        <dd className="text-end">{money(statement.subscriptionFeeMinor)}</dd>
        <dt className="text-muted">{t('sales')}</dt>
        <dd className="text-end text-muted">{money(statement.salesGrossMinor)}</dd>
        <dt className="text-muted">{t('refunds')}</dt>
        <dd className="text-end text-muted">{money(-statement.refundsMinor)}</dd>
        <dt>
          {t('commission', {
            percent: format.number(statement.platformCommissionBps / 100, { maximumFractionDigits: 2 }),
          })}
        </dt>
        <dd className="text-end">{money(statement.platformCommissionMinor)}</dd>
        <dt className="border-t border-line pt-2 text-label">{t('total')}</dt>
        <dd className="border-t border-line pt-2 text-end text-label" data-testid="statement-total">
          {money(statement.totalDueMinor)}
        </dd>
      </dl>
      {statement.paidAt !== null ? (
        <p className="text-body-sm">
          {t('paidOn', {
            date: format.dateTime(new Date(statement.paidAt), { dateStyle: 'medium' }),
            reference: statement.externalReference ?? '—',
          })}
        </p>
      ) : null}
    </>
  );
}
