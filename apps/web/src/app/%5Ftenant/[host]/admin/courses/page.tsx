import { adminCourseListSchema, adminPeriodListSchema } from '@studyhub/contracts';
import { StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { UnpublishCourse } from '../../../../../components/content-admin';
import { CoursePeriodControl } from '../../../../../components/period-admin';
import { COURSE_BADGES } from '../../../../../components/studio-course-frame';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchContent } from '../../../../../lib/content-api';
import { studioTexts } from '../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const terms = await getTerms(await currentTenant(), await getLocale());
  return { title: (await getTranslations('admin.courseList'))('title', terms) };
}

/** S-AD04 Courses: every course of the school; published ones can be taken down with a reason. */
export default async function AdminCoursesPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const terms = await getTerms(tenant, await getLocale());
  const [list, periodList] = await Promise.all([
    fetchContent('/api/v1/admin/courses', adminCourseListSchema),
    fetchContent('/api/v1/admin/periods', adminPeriodListSchema),
  ]);
  const periods = periodList?.periods ?? [];
  const texts = await studioTexts(terms);
  const courses = list?.courses ?? [];
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/courses"
      title={t('admin.courseList.title', terms)}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/courses', label: t('admin.courseList.title', terms) },
      ]}
    >
      {courses.length === 0 ? (
        <StatePanel kind="empty" title={t('admin.courseList.empty', terms)} />
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
          {courses.map((course) => (
            <li key={course.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="flex min-w-0 flex-1 flex-col">
                {course.status === 'PUBLISHED' ? (
                  <NextLink href={`/c/${course.slug}`} className="truncate text-label">
                    {course.title}
                  </NextLink>
                ) : (
                  <span className="truncate text-label">{course.title}</span>
                )}
                <span className="text-caption text-muted">
                  {course.instructorName !== ''
                    ? `${t('admin.courseList.by', { name: course.instructorName })} · `
                    : ''}
                  {format.dateTime(new Date(course.updatedAt), { dateStyle: 'medium' })}
                  {course.period !== null ? ` · ${course.period.name}` : ''}
                </span>
              </div>
              {course.lock !== null ? (
                <StatusBadge status="pending">
                  {course.lock.opensAt === null
                    ? t('admin.courseList.notOpen')
                    : t('admin.courseList.opensOn', {
                        date: format.dateTime(new Date(course.lock.opensAt), { dateStyle: 'medium' }),
                      })}
                </StatusBadge>
              ) : null}
              <StatusBadge status={COURSE_BADGES[course.status]}>
                {t(`studio.statuses.${course.status}`)}
              </StatusBadge>
              {course.status !== 'DRAFT' && course.status !== 'IN_REVIEW' ? (
                <NextLink href={`/admin/courses/${course.id}/access`} className="text-label">
                  {t('admin.courseList.access')}
                </NextLink>
              ) : null}
              {course.status === 'PUBLISHED' ? <UnpublishCourse courseId={course.id} texts={texts} /> : null}
              <CoursePeriodControl
                courseId={course.id}
                periodId={course.period?.id ?? null}
                accessOverride={course.accessOverride}
                periods={periods.filter((p) => !p.archived || p.id === course.period?.id)}
                texts={texts}
              />
            </li>
          ))}
        </ul>
      )}
    </AdminFrame>
  );
}
