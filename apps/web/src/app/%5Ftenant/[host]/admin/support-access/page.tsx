import { type SupportGrant, supportGrantListSchema } from '@studyhub/contracts';
import { Card, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../../components/action-button';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { actionTexts, fetchAdmin } from '../../../../../lib/admin-api';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.support'))('title') };
}

const BADGES = {
  REQUESTED: 'review',
  APPROVED: 'attention',
  ACTIVE: 'attention',
  DENIED: 'draft',
  EXPIRED: 'draft',
  REVOKED: 'draft',
} as const;

/** S-AD16 Support access (F44): approve or deny requests, end active access, see the history. */
export default async function SupportAccessPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const data = await fetchAdmin('/api/v1/admin/support-access', supportGrantListSchema);
  const texts = await actionTexts();
  const grants = data === null || data === 'denied' ? [] : data.grants;
  const requested = grants.filter((g) => g.status === 'REQUESTED');
  const active = grants.filter((g) => g.status === 'APPROVED' || g.status === 'ACTIVE');
  const history = grants.filter((g) => !requested.includes(g) && !active.includes(g));
  const time = (iso: string | null) =>
    iso === null ? '—' : format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const duration = (minutes: number) => t('schoolAdmin.support.duration', { minutes });

  const row = (grant: SupportGrant, actions: React.ReactNode) => (
    <li
      key={grant.id}
      className="flex flex-wrap items-start justify-between gap-3 py-3"
      data-grant={grant.id}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-label">
          {grant.staffName}
          {grant.emergency ? ` · ${t('schoolAdmin.support.emergency')}` : ''}
        </span>
        <span className="text-body-sm">{t('schoolAdmin.support.reason', { reason: grant.reason })}</span>
        <span className="text-caption text-muted">
          {t(`schoolAdmin.support.scope.${grant.scope}`)} · {duration(grant.durationMinutes)}
          {grant.expiresAt !== null
            ? ` · ${t('schoolAdmin.support.until', { time: time(grant.expiresAt) })}`
            : ''}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={BADGES[grant.status]}>
          {t(`schoolAdmin.support.statuses.${grant.status}`)}
        </StatusBadge>
        {actions}
      </div>
    </li>
  );

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/support-access"
      title={t('schoolAdmin.support.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/support-access', label: t('schoolAdmin.support.title') },
      ]}
    >
      <p className="max-w-reading text-body text-muted">{t('schoolAdmin.support.intro')}</p>
      {data === 'denied' ? <StatePanel kind="permission" title={t('system.permission.title')} /> : null}
      <Card>
        <h2 className="text-h3">{t('schoolAdmin.support.requests')}</h2>
        {requested.length === 0 ? (
          <p className="mt-2 text-body text-muted">{t('schoolAdmin.support.none')}</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {requested.map((grant) =>
              row(
                grant,
                <>
                  <ActionButton
                    label={t('schoolAdmin.support.approve')}
                    method="POST"
                    path={`/api/v1/admin/support-access/${grant.id}/decision`}
                    body={{ decision: 'APPROVE' }}
                    variant="primary"
                    texts={texts}
                    testId="approve-support"
                    confirm={{
                      title: t('schoolAdmin.support.approveTitle', { name: grant.staffName }),
                      description: t('schoolAdmin.support.approveBody', {
                        duration: duration(grant.durationMinutes),
                      }),
                      confirmLabel: t('schoolAdmin.support.approve'),
                    }}
                  />
                  <ActionButton
                    label={t('schoolAdmin.support.deny')}
                    method="POST"
                    path={`/api/v1/admin/support-access/${grant.id}/decision`}
                    body={{ decision: 'DENY' }}
                    texts={texts}
                  />
                </>,
              ),
            )}
          </ul>
        )}
      </Card>
      <Card>
        <h2 className="text-h3">{t('schoolAdmin.support.active')}</h2>
        {active.length === 0 ? (
          <p className="mt-2 text-body text-muted">{t('schoolAdmin.support.none')}</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {active.map((grant) =>
              row(
                grant,
                <ActionButton
                  label={t('schoolAdmin.support.revoke')}
                  method="POST"
                  path={`/api/v1/admin/support-access/${grant.id}/revoke`}
                  variant="danger"
                  texts={texts}
                  testId="revoke-support"
                  confirm={{
                    title: t('schoolAdmin.support.revokeTitle', { name: grant.staffName }),
                    confirmLabel: t('schoolAdmin.support.revoke'),
                  }}
                />,
              ),
            )}
          </ul>
        )}
      </Card>
      <Card>
        <h2 className="text-h3">{t('schoolAdmin.support.history')}</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-body text-muted">{t('schoolAdmin.support.none')}</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {history.map((grant) =>
              row(
                grant,
                <NextLink href="/admin/audit-log?action=support." className="text-body-sm">
                  {t('schoolAdmin.support.auditLink')}
                </NextLink>,
              ),
            )}
          </ul>
        )}
      </Card>
    </AdminFrame>
  );
}
