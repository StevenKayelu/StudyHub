import { catalogueResponseSchema, categoryTreeSchema, localizedText } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { CatalogueSearch } from '../../../../components/catalogue-search';
import { CourseGrid } from '../../../../components/course-card';
import { PublicFrame } from '../../../../components/public-frame';
import { fetchContent } from '../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../lib/tenant';

/**
 * S-P01 Home: the school's own headline and introduction (F39, per language), search, then the
 * sections it chose, in its order. "Featured" shows the newest few until courses can be featured;
 * an instructors section has no listing yet and is skipped.
 */
export default async function TenantHomePage() {
  const tenant = await currentTenant();
  if (tenant === null) return null; // the layout has already resolved the school
  const locale = await getLocale();
  const t = await getTranslations();
  const terms = await getTerms(tenant, locale);
  const school = tenant.branding.displayName;
  const layout = tenant.branding.homeLayout;
  const text = (value: Record<string, string> | undefined) =>
    localizedText(value, locale, tenant.locales.defaultLocale);
  const visible = layout.sections.filter((section) => section.visible).map((section) => section.key);
  const newest = await fetchContent('/api/v1/courses?sort=newest&limit=8', catalogueResponseSchema);
  const courses = newest?.items ?? [];
  const tree = visible.includes('categories')
    ? await fetchContent('/api/v1/categories', categoryTreeSchema)
    : null;

  const sections: Record<string, ReactNode> = {
    featured:
      courses.length > 0 ? (
        <section key="featured" aria-labelledby="featured" className="flex flex-col gap-4">
          <h2 id="featured" className="text-h2">
            {t('schoolAdmin.branding.sectionNames.featured')}
          </h2>
          <CourseGrid courses={courses.slice(0, 4)} />
        </section>
      ) : null,
    newest:
      courses.length > 0 ? (
        <section key="newest" aria-labelledby="newest" className="flex flex-col gap-4">
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
      ) : null,
    categories:
      (tree?.categories ?? []).length > 0 ? (
        <section key="categories" aria-labelledby="categories" className="flex flex-col gap-3">
          <h2 id="categories" className="text-h2">
            {t('schoolAdmin.branding.sectionNames.categories')}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {tree!.categories
              .filter((category) => !category.archived)
              .flatMap((category) => category.subjects.filter((subject) => !subject.archived))
              .map((subject) => (
                <li key={subject.id}>
                  <NextLink
                    href={`/browse?subject=${subject.slug}`}
                    className={buttonClasses('secondary', 'sm')}
                  >
                    {subject.name}
                  </NextLink>
                </li>
              ))}
          </ul>
        </section>
      ) : null,
    instructors: null,
  };

  return (
    <PublicFrame tenant={tenant}>
      <section className="flex flex-col gap-3 py-6">
        <h1 className="text-display" data-testid="tenant-name">
          {text(layout.heroTitle) ?? school}
        </h1>
        <p className="max-w-reading text-body-lg text-muted">
          {text(layout.heroSubtitle) ?? t('public.home.subtitle', { ...terms, school })}
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
        visible.map((key) => sections[key])
      )}
    </PublicFrame>
  );
}
