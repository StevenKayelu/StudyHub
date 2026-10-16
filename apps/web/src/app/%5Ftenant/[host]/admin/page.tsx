import { onboardingSchema, queueSummarySchema, reportOverviewSchema } from '@studyhub/contracts';
import { buttonClasses, Card, formatMoney, StatCard, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../components/action-button';
import { AdminFrame } from '../../../../components/workspace-frames';
import { actionTexts, fetchAdmin } from '../../../../lib/admin-api';
import { getMe } from '../../../../lib/session';
import { currentTenant, getTerms } from '../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('admin'))('title') };
}

const QUEUE_LINKS: Record<string, string> = {
  applications: '/admin/instructors',
  reviews: '/admin/reviews',
  paymentExceptions: '/admin/orders?tab=exceptions',
  settlement: '/admin/reconciliation',
  supportAccess: '/admin/support-access',
};

const STEP_LINKS: Record<string, string> = {
  branding: '/admin/branding',
  policies: '/admin/settings#legal',
  payments: '/admin/payments',
  instructors: '/admin/team',
  course: '/admin/courses',
};

/** S-AD01 Overview: the onboarding checklist while setting up (S-AD11), queue cards first (F31), then the last 30 days (F32). */
export default async function AdminOverviewPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const locale = await getLocale();
  const terms = await getTerms(tenant, locale);
  const me = await getMe();
  const owner = me?.membership.roles.includes('TENANT_OWNER') === true && me.support === null;
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const [queues, onboarding, report] = await Promise.all([
    fetchAdmin('/api/v1/admin/queues/summary', queueSummarySchema),
    fetchAdmin('/api/v1/admin/onboarding', onboardingSchema),
    fetchAdmin(`/api/v1/admin/reports/overview?from=${from}&to=${to}&interval=week`, reportOverviewSchema),
  ]);
  const age = (iso: string) => format.relativeTime(new Date(iso));
  const money = (minor: number) =>
    formatMoney(minor, report !== null && report !== 'denied' ? report.currency : 'ZMW', locale);

  return (
    <AdminFrame tenant={tenant} title={t('admin.title')}>
      {onboarding !== null && onboarding !== 'denied' && onboarding.status === 'PROVISIONING' ? (
        <Card>
          <div className="flex flex-col gap-3" data-testid="onboarding">
            <h2 className="text-h3">{t('schoolAdmin.onboarding.title')}</h2>
            <p className="text-body text-muted">{t('schoolAdmin.onboarding.intro')}</p>
            <ol className="flex flex-col divide-y divide-line">
              {onboarding.steps.map((step) => (
                <li key={step.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <NextLink href={STEP_LINKS[step.key] ?? '/admin'} className="text-label">
                    {t(`schoolAdmin.onboarding.steps.${step.key}`, terms)}
                  </NextLink>
                  <StatusBadge status={step.done ? 'published' : step.required ? 'attention' : 'draft'}>
                    {step.done
                      ? t('schoolAdmin.onboarding.done')
                      : step.required
                        ? t('schoolAdmin.onboarding.todo')
                        : t('schoolAdmin.onboarding.optional')}
                  </StatusBadge>
                </li>
              ))}
            </ol>
            <div>
              {owner ? (
                onboarding.canGoLive ? (
                  <ActionButton
                    label={t('schoolAdmin.onboarding.goLive')}
                    method="POST"
                    path="/api/v1/admin/onboarding/go-live"
                    variant="primary"
                    size="md"
                    texts={await actionTexts()}
                    then="reload"
                    testId="go-live"
                    confirm={{
                      title: t('schoolAdmin.onboarding.goLiveTitle'),
                      description: t('schoolAdmin.onboarding.goLiveBody'),
                      confirmLabel: t('schoolAdmin.onboarding.goLive'),
                    }}
                  />
                ) : null
              ) : (
                <p className="text-body-sm text-muted">{t('schoolAdmin.onboarding.onlyOwner')}</p>
              )}
            </div>
          </div>
        </Card>
      ) : null}

      <section aria-labelledby="queues" className="flex flex-col gap-3">
        <h2 id="queues" className="text-h3">
          {t('schoolAdmin.overview.queuesTitle')}
        </h2>
        <div className="grid gap-4 md:grid-cols-3" data-testid="queue-cards">
          {(queues !== null && queues !== 'denied' ? queues.queues : []).map((queue) => (
            <NextLink
              key={queue.key}
              href={QUEUE_LINKS[queue.key] ?? '/admin'}
              className="no-underline"
              data-testid={queue.key === 'paymentExceptions' ? 'exceptions-card' : `queue-${queue.key}`}
            >
              <StatCard
                label={t(`schoolAdmin.overview.queues.${queue.key}`, terms)}
                value={String(queue.count)}
                detail={
                  queue.oldestAt === null
                    ? t('admin.queues.none')
                    : queue.overdue
                      ? t('schoolAdmin.overview.overdue', { age: age(queue.oldestAt) })
                      : t('schoolAdmin.overview.oldest', { age: age(queue.oldestAt) })
                }
              />
            </NextLink>
          ))}
        </div>
      </section>

      {report !== null && report !== 'denied' ? (
        <section aria-labelledby="metrics" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="metrics" className="text-h3">
              {t('schoolAdmin.overview.metricsTitle')}
            </h2>
            <NextLink href="/admin/reports" className={buttonClasses('ghost', 'sm')}>
              {t('schoolAdmin.overview.seeReports')}
            </NextLink>
          </div>
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard label={t('schoolAdmin.overview.gross')} value={money(report.revenue.gross)} />
            <StatCard label={t('schoolAdmin.overview.net')} value={money(report.revenue.net)} />
            <StatCard label={t('schoolAdmin.overview.newLearners')} value={String(report.newLearners)} />
            <StatCard label={t('schoolAdmin.overview.enrolments')} value={String(report.enrolments)} />
          </div>
        </section>
      ) : null}
    </AdminFrame>
  );
}
