import 'server-only';

import type { ConsoleSupportGrant } from '@studyhub/contracts';
import { StatusBadge } from '@studyhub/ui';
import { getFormatter, getTranslations } from 'next-intl/server';

import { actionTexts, formTexts, reauthTexts } from '../lib/admin-api';
import { getConsoleMe } from '../lib/session';
import { ActionButton } from './action-button';
import { type ApiField, ApiForm } from './api-form';

const BADGES = {
  REQUESTED: 'review',
  APPROVED: 'attention',
  ACTIVE: 'attention',
  DENIED: 'draft',
  EXPIRED: 'draft',
  REVOKED: 'draft',
} as const;

/** F44 grants as staff see them: status, and "Open school" / "End access" for the requester. */
export async function ConsoleGrantList({
  grants,
  showTenant,
}: {
  grants: ConsoleSupportGrant[];
  showTenant: boolean;
}) {
  const t = await getTranslations();
  const format = await getFormatter();
  const me = await getConsoleMe();
  const texts = await actionTexts();
  if (grants.length === 0) return <p className="text-body text-muted">{t('platformConsole.support.none')}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line" data-testid="console-grants">
      {grants.map((grant) => {
        const mine = grant.staffId === me?.id;
        const usable = grant.status === 'APPROVED' || grant.status === 'ACTIVE';
        return (
          <li
            key={grant.id}
            className="flex flex-wrap items-start justify-between gap-3 py-3"
            data-grant={grant.id}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-label">
                {showTenant ? `${grant.tenantName} · ` : ''}
                {grant.staffName}
                {grant.emergency ? ` · ${t('platformConsole.detail.emergency')}` : ''}
              </span>
              <span className="text-body-sm">{grant.reason}</span>
              <span className="text-caption text-muted">
                {t(`platformConsole.support.scopes.${grant.scope}`)}
                {grant.expiresAt !== null
                  ? ` · ${t('platformConsole.support.until', {
                      time: format.dateTime(new Date(grant.expiresAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }),
                    })}`
                  : ''}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={BADGES[grant.status]}>
                {t(`platformConsole.support.statuses.${grant.status}`)}
              </StatusBadge>
              {mine && usable ? (
                <ActionButton
                  label={t('platformConsole.support.open')}
                  method="POST"
                  path={`/api/console/support-access/${grant.id}/open`}
                  variant="primary"
                  texts={texts}
                  then="openUrl"
                  testId="open-school"
                />
              ) : null}
              {usable || grant.status === 'REQUESTED' ? (
                <ActionButton
                  label={t('platformConsole.support.end')}
                  method="POST"
                  path={`/api/console/support-access/${grant.id}/end`}
                  texts={texts}
                  testId="end-support"
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Request access to one school (approval needed), or emergency access for the platform owner. */
export async function SupportRequestForm({
  tenants,
  maxHours,
}: {
  /** One fixed school (detail page) or a choice of schools. */
  tenants: { id: string; name: string }[];
  maxHours: number;
}) {
  const t = await getTranslations();
  const me = await getConsoleMe();
  const s = (key: string) => t(`platformConsole.support.${key}`);
  const fields: ApiField[] = [
    ...(tenants.length > 1
      ? [
          {
            kind: 'select' as const,
            name: 'tenantId',
            label: s('tenant'),
            options: tenants.map((tenant) => ({ value: tenant.id, label: tenant.name })),
            defaultValue: tenants[0]!.id,
          },
        ]
      : []),
    { kind: 'textarea', name: 'reason', label: s('reason'), rows: 3, required: true },
    {
      kind: 'select',
      name: 'scope',
      label: s('scope'),
      options: (['READ_ONLY', 'READ_WRITE'] as const).map((scope) => ({
        value: scope,
        label: s(`scopes.${scope}`),
      })),
      defaultValue: 'READ_ONLY',
    },
    {
      kind: 'number',
      name: 'durationMinutes',
      label: `${s('duration')} (15–${maxHours * 60})`,
      defaultValue: Math.min(240, maxHours * 60),
      required: true,
    },
  ];
  const body = tenants.length === 1 ? { tenantId: tenants[0]!.id } : {};
  const texts = await formTexts();
  return (
    <div className="flex flex-col gap-6">
      <ApiForm
        method="POST"
        path="/api/console/support-access"
        body={body}
        fields={fields}
        columns={2}
        submitLabel={s('request')}
        successMessage={s('requested')}
        texts={texts}
        testId="support-request"
      />
      {me?.role === 'PLATFORM_OWNER' ? (
        <details className="rounded-md border border-line p-3">
          <summary className="cursor-pointer text-label">{t('platformConsole.detail.emergency')}</summary>
          <div className="mt-3">
            <ApiForm
              method="POST"
              path="/api/console/support-access/emergency"
              body={body}
              fields={fields}
              columns={2}
              submitLabel={s('emergency')}
              texts={texts}
              reauth={await reauthTexts()}
              testId="support-emergency"
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
