import {
  type ConsolePlan,
  consolePlanListSchema,
  DEFAULT_PLAN_LIMITS,
  FEATURE_KEYS,
  type PlanLimits,
} from '@studyhub/contracts';
import { Card, formatMoney, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../components/action-button';
import { type ApiField, ApiForm } from '../../../../components/api-form';
import { ConsoleFrame } from '../../../../components/workspace-frames';
import { actionTexts, fetchConsole, formTexts, reauthTexts } from '../../../../lib/admin-api';
import { getConsoleMe } from '../../../../lib/session';

export const metadata: Metadata = { title: 'Plans' };

const LIMIT_KEYS = [
  'maxActiveLearners',
  'maxInstructors',
  'maxAdmins',
  'storageGb',
  'videoMinutesPerMonth',
  'maxDocumentMb',
  'maxVideoGb',
] as const satisfies readonly (keyof PlanLimits)[];
const NULLABLE = new Set<string>([
  'maxActiveLearners',
  'maxInstructors',
  'maxAdmins',
  'videoMinutesPerMonth',
]);

/**
 * S-C06 Plans (F40, BR-48, BR-49): features, limits and pricing per plan. Prices are unknown (Q-BIZ-8/9);
 * the seed's plans carry blueprint-default limits and no commission. Only the platform owner edits,
 * after re-authentication; a change applies to every school on the plan at once.
 */
export default async function PlansPage() {
  const t = await getTranslations();
  const p = (key: string, values?: Record<string, string | number>) =>
    t(`platformConsole.plans.${key}`, values);
  const locale = await getLocale();
  const me = await getConsoleMe();
  const owner = me?.role === 'PLATFORM_OWNER';
  const data = await fetchConsole('/plans', consolePlanListSchema);
  const texts = await formTexts();
  const reauth = await reauthTexts();
  const action = await actionTexts();

  const planFields = (plan: ConsolePlan | null): ApiField[] => [
    { kind: 'text', name: 'name', label: p('name'), defaultValue: plan?.name ?? '', required: true },
    ...FEATURE_KEYS.map((key): ApiField => ({
      kind: 'checkbox',
      name: `features.${key}`,
      label: `${p('features')}: ${t(`schoolAdmin.features.names.${key}`)}`,
      defaultValue: plan?.features[key] === true,
    })),
    ...LIMIT_KEYS.map((key): ApiField => ({
      kind: 'number',
      name: `limits.${key}`,
      label: p(`limitNames.${key}`),
      ...(NULLABLE.has(key) && { hint: p('unlimitedHint'), emptyAs: 'null' as const }),
      defaultValue: (plan?.limits ?? DEFAULT_PLAN_LIMITS)[key] as number | null,
    })),
    {
      kind: 'checkbox',
      name: 'limits.hardBlockVideo',
      label: p('hardBlockVideo'),
      defaultValue: (plan?.limits ?? DEFAULT_PLAN_LIMITS).hardBlockVideo,
    },
    {
      kind: 'number',
      name: 'pricing.subscriptionFeeMinor',
      label: p('fee'),
      defaultValue: plan?.pricing.subscriptionFeeMinor ?? 0,
      required: true,
    },
    {
      kind: 'text',
      name: 'pricing.currency',
      label: t('platformConsole.create.currency'),
      defaultValue: plan?.pricing.currency ?? 'ZMW',
      transform: 'upper',
      required: true,
    },
    {
      kind: 'number',
      name: 'pricing.platformCommissionBps',
      label: p('commission'),
      defaultValue: plan?.pricing.platformCommissionBps ?? 0,
      required: true,
    },
    { kind: 'checkbox', name: 'isPublic', label: p('public'), defaultValue: plan?.isPublic ?? true },
  ];

  return (
    <ConsoleFrame current="/plans" title={p('title')}>
      {data === null || data === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2" data-testid="console-plans">
            {data.plans.map((plan) => (
              <Card key={plan.id}>
                <div className="flex flex-col gap-3" data-plan={plan.code}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-h3">{plan.name}</h2>
                    <span className="flex items-center gap-2">
                      {plan.status === 'RETIRED' ? (
                        <StatusBadge status="draft">{p('retired')}</StatusBadge>
                      ) : null}
                      <span className="text-body-sm text-muted">
                        {p('tenants', { count: plan.tenantCount })}
                      </span>
                    </span>
                  </div>
                  <p className="text-caption text-muted">
                    {p('code')}: {plan.code} · v{plan.version}
                  </p>
                  <p className="text-body-sm">
                    {formatMoney(plan.pricing.subscriptionFeeMinor, plan.pricing.currency, locale)} ·{' '}
                    {plan.pricing.platformCommissionBps / 100}%
                  </p>
                  <dl className="grid grid-cols-[1fr_auto] gap-x-4 text-body-sm">
                    {LIMIT_KEYS.map((key) => (
                      <div key={key} className="contents">
                        <dt className="text-muted">{p(`limitNames.${key}`)}</dt>
                        <dd className="text-end tabular">{plan.limits[key] ?? '∞'}</dd>
                      </div>
                    ))}
                  </dl>
                  <ul className="flex flex-wrap gap-2">
                    {FEATURE_KEYS.filter((key) => plan.features[key] === true).map((key) => (
                      <li key={key} className="rounded-full bg-sunken px-3 py-1 text-caption">
                        {t(`schoolAdmin.features.names.${key}`)}
                      </li>
                    ))}
                  </ul>
                  {owner ? (
                    <details className="rounded-md border border-line p-3">
                      <summary className="cursor-pointer text-label">{p('edit')}</summary>
                      <p className="mt-2 text-body-sm text-warning">
                        {p('affects', { count: plan.tenantCount })}
                      </p>
                      <div className="mt-3">
                        <ApiForm
                          method="PATCH"
                          path={`/api/console/plans/${plan.id}`}
                          fields={[
                            ...planFields(plan),
                            {
                              kind: 'textarea',
                              name: 'reason',
                              label: t('schoolAdmin.actions.reason'),
                              rows: 2,
                              required: true,
                            },
                          ]}
                          columns={2}
                          keepValues
                          submitLabel={p('save')}
                          texts={texts}
                          reauth={reauth}
                          testId={`plan-${plan.code}`}
                        />
                      </div>
                    </details>
                  ) : null}
                  {owner && plan.status === 'ACTIVE' ? (
                    <div>
                      <ActionButton
                        label={p('retire')}
                        method="PATCH"
                        path={`/api/console/plans/${plan.id}`}
                        body={{ status: 'RETIRED' }}
                        variant="danger"
                        texts={action}
                        confirm={{
                          title: `${p('retire')}: ${plan.name}`,
                          confirmLabel: p('retire'),
                          reasonLabel: t('schoolAdmin.actions.reason'),
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
          {owner ? (
            <Card>
              <h2 className="text-h3">{p('new')}</h2>
              <div className="mt-3">
                <ApiForm
                  method="POST"
                  path="/api/console/plans"
                  fields={[
                    { kind: 'text', name: 'code', label: p('code'), transform: 'lower', required: true },
                    ...planFields(null),
                  ]}
                  columns={2}
                  submitLabel={p('save')}
                  texts={texts}
                  reauth={reauth}
                  testId="new-plan"
                />
              </div>
            </Card>
          ) : null}
        </>
      )}
    </ConsoleFrame>
  );
}
