import { consoleDomainRequestListSchema } from '@studyhub/contracts';
import { StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../components/action-button';
import { ConsoleFrame } from '../../../../components/workspace-frames';
import { actionTexts, fetchConsole } from '../../../../lib/admin-api';
import { consoleHosts } from '../../../../lib/hosts';

export const metadata: Metadata = { title: 'Address requests' };

const BADGES = {
  REQUESTED: 'review',
  APPROVED: 'published',
  REJECTED: 'failed',
  CANCELLED: 'draft',
} as const;

const schoolSuffix = () =>
  process.env.SCHOOL_HOST_SUFFIX ?? consoleHosts()[0]?.replace(/^console\./, '') ?? 'localhost';

/** Subdomain change requests (S-AD19, BR-50): approve (old host redirects 90 days) or reject. */
export default async function DomainRequestsPage() {
  const t = await getTranslations();
  const format = await getFormatter();
  const data = await fetchConsole('/domain-change-requests', consoleDomainRequestListSchema);
  const texts = await actionTexts();
  const d = (key: string, values?: Record<string, string>) => t(`platformConsole.domains.${key}`, values);
  const requests =
    data === null || data === 'denied'
      ? []
      : [...data.requests].sort(
          (a, b) => Number(b.status === 'REQUESTED') - Number(a.status === 'REQUESTED'),
        );

  return (
    <ConsoleFrame current="/domains" title={d('title')}>
      {data === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : requests.length === 0 ? (
        <StatePanel kind="empty" title={d('none')} />
      ) : (
        <ul
          className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface"
          data-testid="console-domain-requests"
        >
          {requests.map((request) => (
            <li key={request.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
              <div className="flex min-w-0 flex-col gap-1">
                <NextLink href={`/tenants/${request.tenantId}`} className="text-label">
                  {request.tenantName}
                </NextLink>
                <span className="text-body-sm">
                  {d('from', { from: request.currentSlug, to: request.requestedSlug })}
                </span>
                <span className="text-body-sm text-muted">{request.reason}</span>
                {request.decisionNote !== null ? (
                  <span className="text-body-sm text-muted">{request.decisionNote}</span>
                ) : null}
                <span className="text-caption text-muted">
                  {format.dateTime(new Date(request.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={BADGES[request.status]}>
                  {t(`schoolAdmin.domain.statuses.${request.status}`)}
                </StatusBadge>
                {request.status === 'REQUESTED' ? (
                  <>
                    <ActionButton
                      label={d('approve')}
                      method="POST"
                      path={`/api/console/domain-change-requests/${request.id}/decision`}
                      body={{ decision: 'APPROVE' }}
                      variant="primary"
                      texts={texts}
                      testId="approve-domain"
                      confirm={{
                        title: d('approveTitle', {
                          school: request.tenantName,
                          host: `${request.requestedSlug}.${schoolSuffix()}`,
                        }),
                        description: d('approveBody'),
                        confirmLabel: d('approve'),
                        extraField: { name: 'note', label: d('note') },
                      }}
                    />
                    <ActionButton
                      label={d('reject')}
                      method="POST"
                      path={`/api/console/domain-change-requests/${request.id}/decision`}
                      body={{ decision: 'REJECT' }}
                      variant="danger"
                      texts={texts}
                      testId="reject-domain"
                      confirm={{
                        title: d('rejectTitle'),
                        confirmLabel: d('reject'),
                        extraField: { name: 'note', label: d('note') },
                      }}
                    />
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </ConsoleFrame>
  );
}
