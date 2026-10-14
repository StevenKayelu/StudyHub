import 'server-only';

import { type StudioCourse, studioCourseSchema } from '@studyhub/contracts';
import { type BadgeStatus, SecondaryNav, StatusBadge } from '@studyhub/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { cache } from 'react';

import { fetchContent } from '../lib/content-api';
import { currentTenant } from '../lib/tenant';
import { StudioFrame } from './workspace-frames';

export const COURSE_BADGES: Record<StudioCourse['status'], BadgeStatus> = {
  DRAFT: 'draft',
  IN_REVIEW: 'review',
  CHANGES_REQUESTED: 'attention',
  PUBLISHED: 'published',
  UNPUBLISHED: 'pending',
  ARCHIVED: 'draft',
};

/** Statuses in which the owner can still edit (mirrors the API rule; the API decides). */
export const EDITABLE: ReadonlySet<string> = new Set([
  'DRAFT',
  'CHANGES_REQUESTED',
  'PUBLISHED',
  'UNPUBLISHED',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The instructor's own course (404 for anyone else's, or a malformed id). One API call per request. */
export const loadStudioCourse = cache(async (id: string): Promise<StudioCourse> => {
  if (!UUID.test(id)) notFound();
  const course = await fetchContent(`/api/v1/studio/courses/${id}`, studioCourseSchema);
  if (course === null) notFound();
  return course;
});

type Tab = 'outline' | 'details' | 'pricing' | 'publish';

/** Course workspace (S-T03…S-T08): Studio frame, status, and the tabs between its pages. */
export async function StudioCourseFrame({
  course,
  tab,
  extraCrumb,
  children,
}: {
  course: StudioCourse;
  tab: Tab;
  extraCrumb?: { href: string; label: string };
  children: ReactNode;
}) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('studio');
  const base = `/studio/courses/${course.id}`;
  const tabs: { key: Tab; href: string }[] = [
    { key: 'outline', href: base },
    { key: 'details', href: `${base}/details` },
    { key: 'pricing', href: `${base}/pricing` },
    { key: 'publish', href: `${base}/publish` },
  ];
  return (
    <StudioFrame
      tenant={tenant}
      current="/studio"
      title={course.title}
      breadcrumbs={[
        { href: '/studio', label: t('home') },
        { href: base, label: course.title },
        ...(extraCrumb !== undefined ? [extraCrumb] : []),
      ]}
      headerActions={
        <StatusBadge status={COURSE_BADGES[course.status]}>{t(`statuses.${course.status}`)}</StatusBadge>
      }
    >
      <div className="flex flex-col gap-6">
        <SecondaryNav
          label={course.title}
          items={tabs.map((item) => ({
            href: item.href,
            label: t(`tabs.${item.key}`),
            current: item.key === tab,
          }))}
        />
        {children}
      </div>
    </StudioFrame>
  );
}
