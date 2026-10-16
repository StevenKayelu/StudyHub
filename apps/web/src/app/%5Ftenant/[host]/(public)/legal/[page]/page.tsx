import { legalPageResponseSchema, legalPageSchema } from '@studyhub/contracts';
import { StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { PublicFrame } from '../../../../../../components/public-frame';
import { fetchContent } from '../../../../../../lib/content-api';
import { currentTenant } from '../../../../../../lib/tenant';

type Params = Promise<{ page: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const page = legalPageSchema.safeParse((await params).page);
  if (!page.success) return {};
  return { title: (await getTranslations('schoolAdmin.settings.legalNames'))(page.data) };
}

/** The school's own terms, privacy notice and refund policy (F36 per school, F41 legal pages). */
export default async function LegalPage({ params }: { params: Params }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const page = legalPageSchema.safeParse((await params).page);
  if (!page.success) notFound();
  const t = await getTranslations();
  const locale = await getLocale();
  const legal = await fetchContent(`/api/v1/legal/${page.data}?locale=${locale}`, legalPageResponseSchema);
  return (
    <PublicFrame tenant={tenant}>
      <article className="flex max-w-reading flex-col gap-4 py-6">
        <h1 className="text-h1">{t(`schoolAdmin.settings.legalNames.${page.data}`)}</h1>
        {legal?.body === undefined || legal.body === null ? (
          <StatePanel kind="empty" title={t('schoolAdmin.legal.missing')} />
        ) : (
          legal.body.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index} className="whitespace-pre-line text-body">
              {paragraph}
            </p>
          ))
        )}
      </article>
    </PublicFrame>
  );
}
