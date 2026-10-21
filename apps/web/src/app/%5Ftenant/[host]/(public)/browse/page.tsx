import {
  catalogueQuerySchema,
  catalogueResponseSchema,
  categoryTreeSchema,
  periodListSchema,
} from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { CatalogueSearch } from '../../../../../components/catalogue-search';
import { CourseGrid } from '../../../../../components/course-card';
import { PublicFrame } from '../../../../../components/public-frame';
import { fetchContent } from '../../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

type Search = Promise<Record<string, string | string[] | undefined>>;

const LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ALL_LEVELS'] as const;
const PAGE_SIZE = 12;

const selectClasses = 'h-11 w-full rounded-md border border-strong bg-surface px-3 text-body text-ink';

/** Only known filters, validated by the shared contract; anything malformed is simply ignored. */
function filtersFrom(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const flat = Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) => {
      const first = Array.isArray(value) ? value[0] : value;
      return typeof first === 'string' && first !== '' ? [[key, first]] : [];
    }),
  );
  const parsed = catalogueQuerySchema.safeParse(flat);
  if (!parsed.success) return {};
  const { q, subject, level, price, period, sort, cursor } = parsed.data;
  return Object.fromEntries(
    Object.entries({ q, subject, level, price, period, sort, cursor }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
    ),
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await currentTenant();
  const terms = await getTerms(tenant, await getLocale());
  return { title: (await getTranslations('catalogue'))('title', terms) };
}

/** S-P02 Browse: search, filters in the URL (shareable, works without JavaScript), more results. */
export default async function BrowsePage({ searchParams }: { searchParams: Search }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const filters = filtersFrom(await searchParams);
  const { cursor, ...withoutCursor } = filters;
  const { q, ...keptOnSearch } = withoutCursor;
  const [result, tree, periodList] = await Promise.all([
    fetchContent(
      `/api/v1/courses?${new URLSearchParams({ ...filters, limit: String(PAGE_SIZE) }).toString()}`,
      catalogueResponseSchema,
    ),
    fetchContent('/api/v1/categories', categoryTreeSchema),
    fetchContent('/api/v1/periods', periodListSchema),
  ]);
  const periods = periodList?.periods ?? [];
  const items = result?.items ?? [];
  const filtered = Object.keys(withoutCursor).length > 0;
  const nextCursor = result?.page.hasMore === true ? result.page.nextCursor : null;
  const hasMore = nextCursor !== null;
  return (
    <PublicFrame tenant={tenant} current="browse">
      <div className="flex flex-col gap-6 py-4">
        <h1 className="text-h1">{t('catalogue.title', terms)}</h1>
        <CatalogueSearch
          label={t('public.home.searchLabel')}
          placeholder={t('public.home.searchPlaceholder', terms)}
          submitLabel={t('common.search')}
          defaultValue={q}
          hidden={keptOnSearch}
        />
        <form
          method="get"
          action="/browse"
          className="flex flex-col gap-3"
          aria-label={t('catalogue.filters')}
        >
          {q !== undefined ? <input type="hidden" name="q" value={q} /> : null}
          <div
            className={`grid gap-3 sm:grid-cols-2 ${periods.length > 0 ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}
          >
            <label className="flex flex-col gap-1 text-label text-ink">
              {t('catalogue.subject')}
              <select name="subject" defaultValue={filters.subject ?? ''} className={selectClasses}>
                <option value="">{t('catalogue.anySubject')}</option>
                {(tree?.categories ?? []).map((category) => (
                  <optgroup key={category.id} label={category.name}>
                    {category.subjects.map((subject) => (
                      <option key={subject.id} value={subject.slug}>
                        {subject.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {periods.length > 0 ? (
              <label className="flex flex-col gap-1 text-label text-ink">
                {t('catalogue.period')}
                <select name="period" defaultValue={filters.period ?? ''} className={selectClasses}>
                  <option value="">{t('catalogue.anyPeriod')}</option>
                  {periods.map((period) => (
                    <option key={period.id} value={period.id}>
                      {period.name}
                    </option>
                  ))}
                  <option value="open">{t('catalogue.openCourses', terms)}</option>
                </select>
              </label>
            ) : null}
            <label className="flex flex-col gap-1 text-label text-ink">
              {t('catalogue.level')}
              <select name="level" defaultValue={filters.level ?? ''} className={selectClasses}>
                <option value="">{t('catalogue.anyLevel')}</option>
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`catalogue.levels.${level}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-label text-ink">
              {t('catalogue.price')}
              <select name="price" defaultValue={filters.price ?? ''} className={selectClasses}>
                <option value="">{t('catalogue.anyPrice')}</option>
                <option value="free">{t('catalogue.priceFree')}</option>
                <option value="paid">{t('catalogue.pricePaid')}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-label text-ink">
              {t('catalogue.sort')}
              <select name="sort" defaultValue={filters.sort ?? ''} className={selectClasses}>
                <option value="">{t('catalogue.sortRelevance')}</option>
                <option value="newest">{t('catalogue.sortNewest')}</option>
                <option value="popular">{t('catalogue.sortPopular')}</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonClasses('secondary', 'md')}>
              {t('catalogue.apply')}
            </button>
            {filtered ? (
              <NextLink href="/browse" className={buttonClasses('ghost', 'md')}>
                {t('catalogue.clear')}
              </NextLink>
            ) : null}
          </div>
        </form>
        {cursor === undefined && !hasMore && items.length > 0 ? (
          <p className="text-body-sm text-muted" role="status" data-testid="result-count">
            {t('catalogue.results', { count: items.length })}
          </p>
        ) : null}
        {items.length === 0 ? (
          filtered ? (
            <StatePanel
              kind="empty"
              title={t('catalogue.noResultsTitle')}
              message={t('catalogue.noResultsMessage')}
            />
          ) : (
            <StatePanel
              kind="empty"
              title={t('catalogue.emptyTitle', terms)}
              message={t('catalogue.emptyMessage', { ...terms, school: tenant.branding.displayName })}
            />
          )
        ) : (
          <CourseGrid courses={items} />
        )}
        <div className="flex flex-wrap gap-2">
          {cursor !== undefined ? (
            <NextLink
              href={`/browse?${new URLSearchParams(withoutCursor).toString()}`}
              className={buttonClasses('ghost', 'md')}
            >
              {t('common.back')}
            </NextLink>
          ) : null}
          {nextCursor !== null ? (
            <NextLink
              href={`/browse?${new URLSearchParams({ ...withoutCursor, cursor: nextCursor }).toString()}`}
              className={buttonClasses('secondary', 'md')}
              rel="next"
            >
              {t('common.loadMore')}
            </NextLink>
          ) : null}
        </div>
      </div>
    </PublicFrame>
  );
}
