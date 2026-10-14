import { reviewQueueSchema } from '@studyhub/contracts';
import { Card, StatePanel } from '@studyhub/ui';
import { CircleCheck, CircleX } from 'lucide-react';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { ReviewDecision } from '../../../../../components/content-admin';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchContent } from '../../../../../lib/content-api';
import { studioTexts } from '../../../../../lib/studio-texts';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  const terms = await getTerms(await currentTenant(), await getLocale());
  return { title: (await getTranslations('admin.reviews'))('title', terms) };
}

/** S-AD03 Course review queue (F12). */
export default async function ReviewsPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const terms = await getTerms(tenant, await getLocale());
  const queue = await fetchContent('/api/v1/admin/course-reviews', reviewQueueSchema);
  const texts = await studioTexts(terms);
  const items = queue?.items ?? [];
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/reviews"
      title={t('admin.reviews.title', terms)}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/reviews', label: t('admin.reviews.title', terms) },
      ]}
    >
      {items.length === 0 ? (
        <StatePanel kind="empty" title={t('admin.reviews.empty', terms)} />
      ) : (
        <ul className="flex flex-col gap-4" data-testid="review-queue">
          {items.map((item) => (
            <li key={item.submissionId}>
              <Card className="flex flex-col gap-4">
                <div>
                  <h2 className="text-h3">{item.title}</h2>
                  <p className="text-body-sm text-muted">
                    {t('admin.reviews.submitted', {
                      date: format.dateTime(new Date(item.submittedAt), { dateStyle: 'medium' }),
                      name: item.instructorName,
                    })}
                  </p>
                </div>
                <details>
                  <summary className="cursor-pointer text-label">
                    {t('admin.reviews.checklistAtSubmit')}
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1">
                    {item.checklist.map((check) => (
                      <li key={check.key} className="flex items-center gap-2 text-body-sm">
                        {check.ok ? (
                          <CircleCheck aria-label="✓" className="size-4 text-success" />
                        ) : (
                          <CircleX aria-label="✗" className="size-4 text-danger" />
                        )}
                        {check.message}
                      </li>
                    ))}
                  </ul>
                </details>
                <ReviewDecision courseId={item.courseId} texts={texts} />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </AdminFrame>
  );
}
