import { categoryTreeSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { CategoryManager } from '../../../../../components/content-admin';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchContent } from '../../../../../lib/content-api';
import { studioTexts } from '../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('admin.categories'))('title') };
}

/** S-AD06 Categories and subjects (F08). */
export default async function CategoriesPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const tree = (await fetchContent('/api/v1/admin/categories', categoryTreeSchema)) ?? { categories: [] };
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/categories"
      title={t('admin.categories.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/categories', label: t('admin.categories.title') },
      ]}
    >
      <CategoryManager tree={tree} texts={await studioTexts(terms)} />
    </AdminFrame>
  );
}
