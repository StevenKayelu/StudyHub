import { consolePlanListSchema, tenantKindSchema } from '@studyhub/contracts';
import { Card, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ApiForm } from '../../../../../components/api-form';
import { ConsoleFrame } from '../../../../../components/workspace-frames';
import { fetchConsole, formTexts } from '../../../../../lib/admin-api';
import { consoleHosts } from '../../../../../lib/hosts';

export const metadata: Metadata = { title: 'New school' };

/** The domain school subdomains live under (the console host without its `console.` label). */
const schoolSuffix = () =>
  process.env.SCHOOL_HOST_SUFFIX ?? consoleHosts()[0]?.replace(/^console\./, '') ?? 'localhost';

/**
 * S-C04 New school (F37): organisation, address (BR-50, checked by the API), plan, owner's email.
 * The school starts PROVISIONING; its owner gets an invitation valid for 7 days.
 */
export default async function NewTenantPage() {
  const t = await getTranslations();
  const c = (key: string, values?: Record<string, string>) => t(`platformConsole.create.${key}`, values);
  const plans = await fetchConsole('/plans', consolePlanListSchema);
  const active = plans === null || plans === 'denied' ? [] : plans.plans.filter((p) => p.status === 'ACTIVE');

  return (
    <ConsoleFrame
      current="/tenants"
      title={c('title')}
      breadcrumbs={[
        { href: '/tenants', label: t('platformConsole.tenants.title') },
        { href: '/tenants/new', label: c('title') },
      ]}
    >
      {plans === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <Card>
          <ApiForm
            method="POST"
            path="/api/console/tenants"
            columns={2}
            fields={[
              { kind: 'text', name: 'name', label: c('name'), required: true },
              { kind: 'text', name: 'legalName', label: c('legalName') },
              {
                kind: 'select',
                name: 'kind',
                label: c('kind'),
                options: tenantKindSchema.options.map((kind) => ({
                  value: kind,
                  label: t(`platformConsole.kinds.${kind}`),
                })),
                defaultValue: 'SCHOOL',
              },
              {
                kind: 'text',
                name: 'slug',
                label: c('slug'),
                hint: c('slugHint', { host: `{slug}.${schoolSuffix()}` }),
                transform: 'lower',
                required: true,
              },
              {
                kind: 'select',
                name: 'planCode',
                label: c('plan'),
                options: active.map((plan) => ({ value: plan.code, label: plan.name })),
                defaultValue: active[0]?.code ?? '',
              },
              {
                kind: 'text',
                name: 'country',
                label: c('country'),
                defaultValue: 'ZM',
                transform: 'upper',
                required: true,
              },
              {
                kind: 'text',
                name: 'currency',
                label: c('currency'),
                defaultValue: 'ZMW',
                transform: 'upper',
                required: true,
              },
              { kind: 'text', name: 'receiptPrefix', label: c('receiptPrefix'), transform: 'upper' },
              {
                kind: 'email',
                name: 'ownerEmail',
                label: c('ownerEmail'),
                hint: c('ownerHint'),
                required: true,
              },
            ]}
            submitLabel={c('submit')}
            texts={await formTexts()}
            then={{ navigate: '/tenants/{id}' }}
            testId="create-tenant"
          />
        </Card>
      )}
    </ConsoleFrame>
  );
}
