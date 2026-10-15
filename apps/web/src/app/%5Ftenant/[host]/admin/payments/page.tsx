import { paymentAccountListSchema } from '@studyhub/contracts';
import { StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { PaymentAccountAdmin } from '../../../../../components/payment-account-admin';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { commerceTexts } from '../../../../../lib/commerce-texts';
import { fetchContent } from '../../../../../lib/content-api';
import { requireMember } from '../../../../../lib/session';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.admin.account'))('title') };
}

/** S-AD15 Payment account (F45): the owner connects the school's own merchant account. */
export default async function PaymentAccountPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const me = await requireMember();
  const t = await getTranslations();
  const format = await getFormatter();
  const terms = await getTerms(tenant, await getLocale());
  const owner = me.membership.roles.includes('TENANT_OWNER');
  const list = owner ? await fetchContent('/api/v1/admin/payment-accounts', paymentAccountListSchema) : null;
  const accounts = list?.accounts ?? [];
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/payments"
      title={t('commerce.admin.account.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/payments', label: t('commerce.admin.account.title') },
      ]}
    >
      <p className="max-w-reading text-muted">{t('commerce.admin.account.intro', terms)}</p>
      {owner ? (
        <PaymentAccountAdmin
          initial={accounts}
          texts={await commerceTexts(terms)}
          formatTime={Object.fromEntries(
            accounts
              .filter((a) => a.lastTestedAt !== null)
              .map((a) => [
                a.id,
                format.dateTime(new Date(a.lastTestedAt!), { dateStyle: 'medium', timeStyle: 'short' }),
              ]),
          )}
        />
      ) : (
        <StatePanel kind="permission" title={t('commerce.admin.account.ownerOnly')} />
      )}
    </AdminFrame>
  );
}
