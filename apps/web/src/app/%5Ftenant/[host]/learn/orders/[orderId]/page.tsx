import { orderViewSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { Checkout } from '../../../../../../components/checkout';
import { LearnFrame } from '../../../../../../components/learn-frame';
import { commerceTexts } from '../../../../../../lib/commerce-texts';
import { fetchLearning, UUID } from '../../../../../../lib/learn-api';
import { requireMember } from '../../../../../../lib/session';
import { currentTenant, getTerms } from '../../../../../../lib/tenant';

type Params = Promise<{ orderId: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.checkout'))('title'), robots: { index: false } };
}

/** S-L08–S-L10: checkout, payment status and success for one order (F25). */
export default async function OrderPage({ params }: { params: Params }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  await requireMember();
  const { orderId } = await params;
  if (!UUID.test(orderId)) notFound();
  const order = await fetchLearning(`/api/v1/orders/${orderId}`, orderViewSchema);
  if (order === null || order === 'locked') notFound();
  const locale = await getLocale();
  const t = await getTranslations('commerce.checkout');
  return (
    <LearnFrame tenant={tenant} current="learning">
      <h1 className="mb-4 text-h1">{t('title')}</h1>
      <Checkout
        initial={order}
        texts={await commerceTexts(await getTerms(tenant, locale))}
        locale={locale}
        defaultPhone=""
      />
    </LearnFrame>
  );
}
