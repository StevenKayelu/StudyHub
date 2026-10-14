import { instructorQueueSchema } from '@studyhub/contracts';
import { Card, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { InstructorDecision } from '../../../../../components/content-admin';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchContent } from '../../../../../lib/content-api';
import { studioTexts } from '../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const terms = await getTerms(await currentTenant(), await getLocale());
  return { title: (await getTranslations('admin.instructors'))('title', terms) };
}

/** S-AD05 Instructor applications (F06). */
export default async function InstructorsPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const queue = await fetchContent('/api/v1/admin/instructor-applications', instructorQueueSchema);
  const texts = await studioTexts(terms);
  const items = queue?.items ?? [];
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/instructors"
      title={t('admin.instructors.title', terms)}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/instructors', label: t('admin.instructors.title', terms) },
      ]}
    >
      <section aria-labelledby="applications" className="flex flex-col gap-4">
        <h2 id="applications" className="text-h2">
          {t('admin.instructors.applications')}
        </h2>
        {items.length === 0 ? (
          <StatePanel kind="empty" title={t('admin.instructors.empty')} />
        ) : (
          <ul className="flex flex-col gap-4" data-testid="instructor-applications">
            {items.map((item) => (
              <li key={item.membershipId}>
                <Card className="flex flex-col gap-3">
                  <div>
                    <h3 className="text-h3">{item.displayName}</h3>
                    {item.headline !== null ? <p className="text-muted">{item.headline}</p> : null}
                  </div>
                  {item.subjects.length > 0 ? (
                    <p className="text-body-sm">
                      <span className="text-label">{t('instructor.subjects')}: </span>
                      {item.subjects.join(', ')}
                    </p>
                  ) : null}
                  {item.bio !== null ? <p className="whitespace-pre-line text-body-sm">{item.bio}</p> : null}
                  {item.qualifications !== null ? (
                    <div className="text-body-sm">
                      <p className="text-label">{t('instructor.qualifications')}</p>
                      <p className="whitespace-pre-line">{item.qualifications}</p>
                    </div>
                  ) : null}
                  <InstructorDecision membershipId={item.membershipId} texts={texts} />
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AdminFrame>
  );
}
