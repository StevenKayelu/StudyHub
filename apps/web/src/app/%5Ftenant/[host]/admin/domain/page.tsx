import { adminDomainsSchema } from '@studyhub/contracts';
import { Card, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../../components/action-button';
import { DomainRequestForm } from '../../../../../components/domain-request-form';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { actionTexts, fetchAdmin, formTexts } from '../../../../../lib/admin-api';
import { getMe } from '../../../../../lib/session';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.domain'))('title') };
}

const REQUEST_BADGES = {
  REQUESTED: 'review',
  APPROVED: 'published',
  REJECTED: 'failed',
  CANCELLED: 'draft',
} as const;

/** S-AD19 Domain (BR-50): the school's addresses and subdomain change requests. Custom domains: LATER. */
export default async function DomainPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const me = await getMe();
  const owner = me?.membership.roles.includes('TENANT_OWNER') === true && me.support === null;
  const data = await fetchAdmin('/api/v1/admin/domains', adminDomainsSchema);
  const texts = await actionTexts();
  const day = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/domain"
      title={t('schoolAdmin.domain.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/domain', label: t('schoolAdmin.domain.title') },
      ]}
    >
      {data === null || data === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <>
          <Card>
            <h2 className="text-h3">{t('schoolAdmin.domain.current')}</h2>
            <ul className="mt-2 flex flex-col divide-y divide-line" data-testid="domains">
              {data.domains.map((domain) => (
                <li
                  key={domain.hostname}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                  data-host={domain.hostname}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="break-all text-label">{domain.hostname}</span>
                    {domain.status === 'REDIRECT' && domain.redirectUntil !== null ? (
                      <span className="text-caption text-muted">
                        {t('schoolAdmin.domain.redirecting', { date: day(domain.redirectUntil) })}
                      </span>
                    ) : null}
                  </div>
                  {domain.isPrimary ? (
                    <a
                      href={`https://${domain.hostname}`}
                      className="text-body-sm"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('schoolAdmin.domain.open')}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-body-sm text-muted">{t('schoolAdmin.domain.custom')}</p>
          </Card>
          <Card>
            <h2 className="text-h3">{t('schoolAdmin.domain.request')}</h2>
            <div className="mt-3">
              {owner ? (
                <DomainRequestForm
                  texts={{
                    ...(await formTexts()),
                    slug: t('schoolAdmin.domain.slug'),
                    reason: t('schoolAdmin.domain.reason'),
                    check: t('schoolAdmin.domain.check'),
                    available: t.raw('schoolAdmin.domain.available') as string,
                    problems: t.raw('schoolAdmin.domain.problems') as Record<string, string>,
                    submit: t('schoolAdmin.domain.submit'),
                    sent: t('schoolAdmin.domain.sent'),
                    suffix: platformSuffix(data.slug, data.domains),
                  }}
                />
              ) : (
                <p className="text-body-sm text-muted">{t('schoolAdmin.domain.onlyOwner')}</p>
              )}
            </div>
          </Card>
          {data.requests.length > 0 ? (
            <Card>
              <h2 className="text-h3">{t('schoolAdmin.domain.requests')}</h2>
              <ul className="mt-2 flex flex-col divide-y divide-line" data-testid="domain-requests">
                {data.requests.map((request) => (
                  <li key={request.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-label">
                        {request.currentSlug} → {request.requestedSlug}
                      </span>
                      <span className="text-body-sm">{request.reason}</span>
                      {request.decisionNote !== null ? (
                        <span className="text-body-sm text-muted">{request.decisionNote}</span>
                      ) : null}
                      <span className="text-caption text-muted">{day(request.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={REQUEST_BADGES[request.status]}>
                        {t(`schoolAdmin.domain.statuses.${request.status}`)}
                      </StatusBadge>
                      {owner && request.status === 'REQUESTED' ? (
                        <ActionButton
                          label={t('schoolAdmin.domain.cancel')}
                          method="POST"
                          path={`/api/v1/admin/domains/change-requests/${request.id}/cancel`}
                          texts={texts}
                        />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      )}
    </AdminFrame>
  );
}

/** The platform domain under which subdomains live: the primary host without the school's slug. */
function platformSuffix(
  slug: string,
  domains: { hostname: string; isPrimary: boolean; type: string }[],
): string {
  const primary = domains.find((d) => d.isPrimary && d.type === 'SUBDOMAIN') ?? domains[0];
  if (primary === undefined) return '';
  return primary.hostname.startsWith(`${slug}.`)
    ? primary.hostname.slice(slug.length + 1)
    : primary.hostname.split('.').slice(1).join('.');
}
