import {
  consolePlanListSchema,
  consoleSettingsSchema,
  consoleTenantDetailSchema,
  DEFAULT_CONSOLE_SETTINGS,
} from '@studyhub/contracts';
import { Card, Money, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { ActionButton } from '../../../../../components/action-button';
import { ApiForm } from '../../../../../components/api-form';
import { ConsoleGrantList, SupportRequestForm } from '../../../../../components/console-support';
import { STATEMENT_BADGES, TENANT_BADGES } from '../../../../../components/order-badges';
import { ConsoleFrame } from '../../../../../components/workspace-frames';
import { actionTexts, fetchConsole, formTexts, reauthTexts } from '../../../../../lib/admin-api';
import { getConsoleMe } from '../../../../../lib/session';

export const metadata: Metadata = { title: 'School' };

const ACTIONS_BY_STATUS = {
  PROVISIONING: ['activate', 'offboard'],
  ACTIVE: ['suspend', 'offboard'],
  SUSPENDED: ['unsuspend', 'offboard'],
  OFFBOARDING: ['cancel-offboarding'],
  DELETED: [],
} as const;

const GB = 1024 ** 3;

/**
 * S-C05 School detail (F43): metadata, domains, plan and overrides, usage, lifecycle, support access
 * and statements. No member's personal data is shown (F43 AC 1); the owner contact is the documented
 * exception (what staff entered at provisioning).
 */
export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations();
  const d = (key: string, values?: Record<string, string | number>) =>
    t(`platformConsole.detail.${key}`, values);
  const format = await getFormatter();
  const locale = await getLocale();
  const me = await getConsoleMe();
  const manager = me?.role === 'PLATFORM_OWNER' || me?.role === 'PLATFORM_OPERATOR';
  const data = await fetchConsole(`/tenants/${encodeURIComponent(id)}`, consoleTenantDetailSchema);
  if (data === null) notFound();
  if (data === 'denied') {
    return (
      <ConsoleFrame current="/tenants" title={t('platformConsole.tenants.title')}>
        <StatePanel kind="permission" title={t('system.permission.title')} />
      </ConsoleFrame>
    );
  }
  const [plans, settings] = await Promise.all([
    manager ? fetchConsole('/plans', consolePlanListSchema) : Promise.resolve(null),
    me?.role === 'PLATFORM_OWNER' ? fetchConsole('/settings', consoleSettingsSchema) : Promise.resolve(null),
  ]);
  const maxHours =
    settings === null || settings === 'denied'
      ? DEFAULT_CONSOLE_SETTINGS.supportMaxHours
      : settings.supportMaxHours;
  const texts = await actionTexts();
  const { tenant } = data;
  const date = (iso: string | null) =>
    iso === null ? '—' : format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const section = (key: string, children: ReactNode) => (
    <Card>
      <section aria-labelledby={`section-${key}`} data-section={key}>
        <h2 id={`section-${key}`} className="text-h3">
          {d(`tabs.${key}`)}
        </h2>
        <div className="mt-3">{children}</div>
      </section>
    </Card>
  );

  return (
    <ConsoleFrame
      current="/tenants"
      title={tenant.name}
      breadcrumbs={[
        { href: '/tenants', label: t('platformConsole.tenants.title') },
        { href: `/tenants/${id}`, label: tenant.name },
      ]}
    >
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={TENANT_BADGES[tenant.status]}>
          {t(`platformConsole.statuses.${tenant.status}`)}
        </StatusBadge>
        <span className="text-body-sm text-muted">{t(`platformConsole.kinds.${tenant.kind}`)}</span>
      </div>

      {section(
        'overview',
        <>
          <dl
            className="grid gap-x-6 gap-y-2 text-body md:grid-cols-[auto_1fr]"
            data-testid="tenant-metadata"
          >
            {tenant.legalName !== null ? (
              <>
                <dt className="text-label text-muted">{t('platformConsole.create.legalName')}</dt>
                <dd>{tenant.legalName}</dd>
              </>
            ) : null}
            <dt className="text-label text-muted">{d('ownerContact')}</dt>
            <dd className="break-all">{tenant.ownerContactEmail ?? '—'}</dd>
            <dt className="text-label text-muted">{d('country')}</dt>
            <dd>{tenant.country}</dd>
            <dt className="text-label text-muted">{d('currency')}</dt>
            <dd>{tenant.currency}</dd>
            <dt className="text-label text-muted">{d('receiptPrefix')}</dt>
            <dd>{tenant.receiptPrefix ?? '—'}</dd>
            <dt className="text-label text-muted">{d('created')}</dt>
            <dd>{date(tenant.createdAt)}</dd>
            <dt className="text-label text-muted">{d('activated')}</dt>
            <dd>{date(tenant.activatedAt)}</dd>
            {tenant.suspendedReason !== null ? (
              <>
                <dt className="text-label text-muted">{d('suspendedReason')}</dt>
                <dd>{tenant.suspendedReason}</dd>
              </>
            ) : null}
            {tenant.deleteAfter !== null ? (
              <>
                <dt className="text-label text-muted">{d('deleteAfter')}</dt>
                <dd>{date(tenant.deleteAfter)}</dd>
              </>
            ) : null}
          </dl>
          {manager && tenant.status === 'PROVISIONING' ? (
            <div className="mt-3">
              <ActionButton
                label={d('resendInvitation')}
                method="POST"
                path={`/api/console/tenants/${id}/owner-invitation`}
                body={{}}
                texts={texts}
                doneLabel={d('invitationSent')}
                testId="resend-owner-invitation"
              />
            </div>
          ) : null}
        </>,
      )}

      {section(
        'domains',
        <ul className="flex flex-col divide-y divide-line">
          {data.domains.map((domain) => (
            <li key={domain.hostname} className="flex flex-wrap justify-between gap-2 py-2">
              <span className="break-all text-label">{domain.hostname}</span>
              <span className="text-body-sm text-muted">
                {domain.isPrimary ? '★ ' : ''}
                {domain.status}
                {domain.redirectUntil !== null ? ` · ${date(domain.redirectUntil)}` : ''}
              </span>
            </li>
          ))}
        </ul>,
      )}

      {section(
        'plan',
        <div className="flex flex-col gap-4">
          <p className="text-body">
            {d('planLabel')}:{' '}
            <span className="text-label">{data.plan?.name ?? t('platformConsole.tenants.noPlan')}</span>
          </p>
          {manager && plans !== null && plans !== 'denied' ? (
            <details className="rounded-md border border-line p-3">
              <summary className="cursor-pointer text-label">{d('changePlan')}</summary>
              <div className="mt-3">
                <ApiForm
                  method="PATCH"
                  path={`/api/console/tenants/${id}`}
                  fields={[
                    {
                      kind: 'select',
                      name: 'planCode',
                      label: d('planLabel'),
                      options: plans.plans
                        .filter((plan) => plan.status === 'ACTIVE')
                        .map((plan) => ({ value: plan.code, label: plan.name })),
                      defaultValue: data.plan?.code ?? plans.plans[0]?.code ?? '',
                    },
                    {
                      kind: 'textarea',
                      name: 'reason',
                      label: t('schoolAdmin.actions.reason'),
                      rows: 2,
                      required: true,
                    },
                  ]}
                  submitLabel={d('changePlan')}
                  texts={await formTexts()}
                  reauth={await reauthTexts()}
                  testId="change-plan"
                />
              </div>
            </details>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-body-sm" data-testid="tenant-features">
              <thead className="text-caption text-muted">
                <tr>
                  <th scope="col" className="py-2 pe-3">
                    {d('features')}
                  </th>
                  <th scope="col" className="py-2 pe-3">
                    {d('planGrants')}
                  </th>
                  <th scope="col" className="py-2 pe-3">
                    {d('override')}
                  </th>
                  <th scope="col" className="py-2 pe-3">
                    {d('schoolSwitch')}
                  </th>
                  <th scope="col" className="py-2 pe-3">
                    {d('effective')}
                  </th>
                  {manager ? <th scope="col" className="py-2" /> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.features.map((feature) => (
                  <tr key={feature.key} data-feature={feature.key}>
                    <th scope="row" className="py-2 pe-3 font-normal">
                      {t(`schoolAdmin.features.names.${feature.key}`)}
                    </th>
                    <td className="py-2 pe-3">{feature.planGrants ? d('yes') : d('no')}</td>
                    <td className="py-2 pe-3">{d(`overrides.${feature.override}`)}</td>
                    <td className="py-2 pe-3">{feature.enabledByTenant ? d('yes') : d('no')}</td>
                    <td className="py-2 pe-3">
                      <StatusBadge status={feature.effective ? 'published' : 'draft'}>
                        {feature.effective ? d('yes') : d('no')}
                      </StatusBadge>
                    </td>
                    {manager ? (
                      <td className="py-2">
                        <span className="flex flex-wrap gap-1">
                          {(['NONE', 'GRANT', 'REVOKE'] as const)
                            .filter((value) => value !== feature.override)
                            .map((value) => (
                              <ActionButton
                                key={value}
                                label={d('setOverride', { override: d(`overrides.${value}`) })}
                                method="PUT"
                                path={`/api/console/tenants/${id}/features/${feature.key}`}
                                body={{ override: value }}
                                texts={texts}
                                testId={`override-${feature.key}-${value}`}
                                confirm={{
                                  title: `${t(`schoolAdmin.features.names.${feature.key}`)}: ${d(`overrides.${value}`)}`,
                                  confirmLabel: d('setOverride', { override: d(`overrides.${value}`) }),
                                  reasonLabel: t('schoolAdmin.actions.reason'),
                                }}
                              />
                            ))}
                        </span>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>,
      )}

      {section(
        'usage',
        data.usage.length === 0 ? (
          <p className="text-body text-muted">{d('noUsage')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-body-sm">
              <thead className="text-caption text-muted">
                <tr>
                  <th scope="col" className="py-2 pe-4">
                    {t('schoolAdmin.usage.date')}
                  </th>
                  <th scope="col" className="py-2 pe-4 text-end">
                    {t('platformConsole.tenants.columns.learners')}
                  </th>
                  <th scope="col" className="py-2 pe-4 text-end">
                    {t('platformConsole.tenants.columns.storage')}
                  </th>
                  <th scope="col" className="py-2 pe-4 text-end">
                    {t('schoolAdmin.usage.emails')}
                  </th>
                  <th scope="col" className="py-2 text-end">
                    {t('schoolAdmin.usage.payments')}
                  </th>
                </tr>
              </thead>
              <tbody className="tabular divide-y divide-line">
                {data.usage.map((day) => (
                  <tr key={day.date}>
                    <th scope="row" className="py-2 pe-4 font-normal">
                      {day.date}
                    </th>
                    <td className="py-2 pe-4 text-end">{day.activeLearners}</td>
                    <td className="py-2 pe-4 text-end">
                      {format.number(day.storageBytes / GB, { maximumFractionDigits: 2 })} GB
                    </td>
                    <td className="py-2 pe-4 text-end">{day.emailsSent}</td>
                    <td className="py-2 text-end">{day.paymentsCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}

      {manager
        ? section(
            'lifecycle',
            ACTIONS_BY_STATUS[tenant.status].length === 0 ? (
              <p className="text-body text-muted">{t(`platformConsole.statuses.${tenant.status}`)}</p>
            ) : (
              <div className="flex flex-wrap gap-2" data-testid="lifecycle-actions">
                {ACTIONS_BY_STATUS[tenant.status].map((action) => (
                  <ActionButton
                    key={action}
                    label={d(`actions.${action}`)}
                    method="POST"
                    path={`/api/console/tenants/${id}/${action}`}
                    variant={action === 'offboard' || action === 'suspend' ? 'danger' : 'primary'}
                    texts={texts}
                    testId={`lifecycle-${action}`}
                    confirm={{
                      title: d(`actionTitles.${action}`, { name: tenant.name }),
                      description: d(`actionBodies.${action}`),
                      confirmLabel: d(`actions.${action}`),
                      reasonLabel: t('schoolAdmin.actions.reason'),
                    }}
                  />
                ))}
              </div>
            ),
          )
        : null}

      {section(
        'support',
        <div className="flex flex-col gap-6">
          {tenant.status === 'ACTIVE' || tenant.status === 'SUSPENDED' || tenant.status === 'PROVISIONING' ? (
            <SupportRequestForm tenants={[{ id: tenant.id, name: tenant.name }]} maxHours={maxHours} />
          ) : null}
          <ConsoleGrantList grants={data.supportGrants} showTenant={false} />
        </div>,
      )}

      {section(
        'billing',
        data.statements.length === 0 ? (
          <p className="text-body text-muted">{t('schoolAdmin.billing.none')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {data.statements.map((statement) => (
              <li key={statement.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <NextLink href={`/statements?period=${statement.period}`} className="text-label tabular">
                  {statement.period}
                </NextLink>
                <span className="flex items-center gap-2">
                  <Money
                    amountMinor={statement.totalDueMinor}
                    currency={statement.currency}
                    locale={locale}
                  />
                  <StatusBadge status={STATEMENT_BADGES[statement.status]}>
                    {t(`schoolAdmin.billing.statuses.${statement.status}`)}
                  </StatusBadge>
                </span>
              </li>
            ))}
          </ul>
        ),
      )}
    </ConsoleFrame>
  );
}
