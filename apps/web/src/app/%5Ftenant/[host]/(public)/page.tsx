import { catalogueResponseSchema } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { CatalogueSearch } from '../../../../components/catalogue-search';
import { CourseGrid } from '../../../../components/course-card';
import { PublicFrame } from '../../../../components/public-frame';
import { fetchContent } from '../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../lib/tenant';

/** S-P01 Home: search first, then the newest courses (F13). */
export default async function TenantHomePage() {
  const tenant = await currentTenant();
  if (tenant === null) return null; // the layout has already resolved the school
  const locale = await getLocale();
  const t = await getTranslations();
  const terms = await getTerms(tenant, locale);
  const school = tenant.branding.displayName;
  const newest = await fetchContent('/api/v1/courses?sort=newest&limit=8', catalogueResponseSchema);
  const courses = newest?.items ?? [];
  return (
    <PublicFrame tenant={tenant}>
      <section className="flex flex-col gap-3 py-6">
        <h1 className="text-display" data-testid="tenant-name">
          {school}
        </h1>
        <p className="max-w-reading text-body-lg text-muted">
          {t('public.home.subtitle', { ...terms, school })}
        </p>
        <div className="mt-2">
          <CatalogueSearch
            label={t('public.home.searchLabel')}
            placeholder={t('public.home.searchPlaceholder', terms)}
            submitLabel={t('common.search')}
          />
        </div>
      </section>
      {courses.length === 0 ? (
        <StatePanel
          kind="empty"
          title={t('public.home.emptyTitle', terms)}
          message={t('public.home.emptyMessage', { ...terms, school })}
        />
      ) : (
        <section aria-labelledby="newest" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="newest" className="text-h2">
              {t('public.home.newest', terms)}
            </h2>
            <NextLink href="/browse" className={buttonClasses('ghost', 'sm')}>
              {t('public.home.browseAll', terms)}
            </NextLink>
          </div>
          <CourseGrid courses={courses} />
        </section>
      )}
    </PublicFrame>
  );
}
