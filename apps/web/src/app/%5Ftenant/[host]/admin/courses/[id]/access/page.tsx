import { adminEnrollmentsSchema } from '@studyhub/contracts';
import { StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { GrantAccess, RevokeAccess } from '../../../../../../../components/enrollment-admin';
import { AdminFrame } from '../../../../../../../components/workspace-frames';
import { fetchContent } from '../../../../../../../lib/content-api';
import { UUID } from '../../../../../../../lib/learn-api';
import { studioTexts } from '../../../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../../../lib/tenant';

type Params = Promise<{ id: string }>;

async function load(id: string) {
  if (!UUID.test(id)) notFound();
  const data = await fetchContent(`/api/v1/admin/courses/${id}/enrollments`, adminEnrollmentsSchema);
  if (data === null) notFound();
  return data;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const data = await load((await params).id);
  return { title: (await getTranslations('admin.enrollments'))('title', { course: data.course.title }) };
}

const BADGES = { ACTIVE: 'published', EXPIRED: 'draft', REVOKED: 'failed' } as const;

/** Course access for administrators: every enrolment, with grant and revoke (F14, audited). */
export default async function CourseAccessPage({ params }: { params: Params }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const data = await load((await params).id);
  const t = await getTranslations();
  const format = await getFormatter();
  const terms = await getTerms(tenant, await getLocale());
  const texts = await studioTexts(terms);
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/courses"
      title={t('admin.enrollments.title', { course: data.course.title })}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/courses', label: t('admin.courseList.title', terms) },
        { href: `/admin/courses/${data.course.id}/access`, label: data.course.title },
      ]}
    >
      <div className="flex flex-col gap-6">
        <GrantAccess courseId={data.course.id} texts={texts} />
        {data.items.length === 0 ? (
          <StatePanel kind="empty" title={t('admin.enrollments.empty')} />
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {data.items.map((item) => (
              <li key={item.enrollmentId} className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-label">{item.name}</span>
                  <span className="text-caption text-muted">
                    {[
                      item.email,
                      t(`admin.enrollments.sources.${item.source}`),
                      t('admin.enrollments.started', {
                        date: format.dateTime(new Date(item.startedAt), { dateStyle: 'medium' }),
                      }),
                      t('admin.enrollments.progress', { percent: item.progressPercent }),
                    ].join(' · ')}
                  </span>
                  {item.revokeReason !== null ? (
                    <span className="text-caption text-muted">{item.revokeReason}</span>
                  ) : null}
                </div>
                <StatusBadge status={BADGES[item.status]}>
                  {t(`admin.enrollments.statuses.${item.status}`)}
                </StatusBadge>
                {item.status === 'ACTIVE' ? (
                  <RevokeAccess enrollmentId={item.enrollmentId} texts={texts} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminFrame>
  );
}
