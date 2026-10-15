import { instructorLedgerSchema } from '@studyhub/contracts';
import { Alert } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { LedgerTable } from '../../../../../../components/ledger-table';
import { PayoutRun } from '../../../../../../components/payout-run';
import { AdminFrame } from '../../../../../../components/workspace-frames';
import { commerceTexts } from '../../../../../../lib/commerce-texts';
import { fetchContent } from '../../../../../../lib/content-api';
import { UUID } from '../../../../../../lib/learn-api';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

type Params = Promise<{ membershipId: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.admin.payouts'))('title') };
}

/** S-AD05 payout run for one instructor (W3), and their full ledger. */
export default async function InstructorPayoutPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const { membershipId } = await params;
  if (!UUID.test(membershipId)) notFound();
  const ledger = await fetchContent(`/api/v1/admin/earnings/${membershipId}`, instructorLedgerSchema);
  if (ledger === null) notFound();
  const t = await getTranslations('commerce.admin.payouts');
  const locale = await getLocale();
  const texts = await commerceTexts(await getTerms(tenant, locale));
  const recorded = (await searchParams).recorded === '1';
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/payouts"
      title={ledger.name}
      breadcrumbs={[
        { href: '/admin/payouts', label: t('title') },
        { href: `/admin/payouts/${membershipId}`, label: ledger.name },
      ]}
    >
      <NextLink href="/admin/payouts" className="text-label">
        {t('back')}
      </NextLink>
      {recorded ? <Alert tone="success">{t('recorded')}</Alert> : null}
      <p className="text-body-sm">
        {t('method')}: {ledger.payoutMethodHint ?? t('noMethod')}
      </p>
      <PayoutRun
        membershipId={membershipId}
        entries={ledger.entries}
        texts={texts}
        locale={locale}
        today={new Date().toISOString().slice(0, 10)}
      />
      <LedgerTable entries={[...ledger.entries].reverse()} texts={texts} locale={locale} />
    </AdminFrame>
  );
}
