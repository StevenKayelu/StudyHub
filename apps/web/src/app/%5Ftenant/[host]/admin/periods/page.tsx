import { adminPeriodListSchema } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { PeriodManager, type PeriodRow } from '../../../../../components/period-admin';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchContent } from '../../../../../lib/content-api';
import { studioTexts } from '../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('admin.periods'))('title') };
}

/** Terms & semesters (docs/design/course-periods.md): when each group of courses opens. */
export default async function PeriodsPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const terms = await getTerms(tenant, await getLocale());
  const list = (await fetchContent('/api/v1/admin/periods', adminPeriodListSchema)) ?? { periods: [] };
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const periods: PeriodRow[] = list.periods.map((p) => ({
    ...p,
    datesLabel:
      p.endsAt === null
        ? t('admin.periods.from', { start: date(p.startsAt) })
        : t('admin.periods.dates', { start: date(p.startsAt), end: date(p.endsAt) }),
    statusLabel: p.open
      ? t('admin.periods.open')
      : p.mode === 'LOCKED'
        ? t('admin.periods.locked')
        : t('admin.periods.opensOn', { date: date(p.startsAt) }),
    courseCountLabel: t('admin.periods.courseCount', { ...terms, count: p.courseCount }),
  }));
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/periods"
      title={t('admin.periods.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/periods', label: t('admin.periods.title') },
      ]}
    >
      <PeriodManager periods={periods} texts={await studioTexts(terms)} />
    </AdminFrame>
  );
}
