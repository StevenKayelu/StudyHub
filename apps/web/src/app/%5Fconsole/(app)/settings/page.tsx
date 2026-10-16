import { consoleSettingsSchema, paymentProviderListSchema, providerHealthSchema } from '@studyhub/contracts';
import { Card, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ApiForm } from '../../../../components/api-form';
import { ConsoleFrame } from '../../../../components/workspace-frames';
import { fetchConsole, formTexts, reauthTexts } from '../../../../lib/admin-api';

export const metadata: Metadata = { title: 'Settings' };

const HEALTH_BADGES = { OK: 'published', DEGRADED: 'attention', DOWN: 'failed', UNKNOWN: 'draft' } as const;

/**
 * S-C08 Global settings (platform owner): the maintenance banner, the longest support grant (BR-47),
 * provider health, and which payment providers have client approval (Q-PAY-3: none yet).
 */
export default async function ConsoleSettingsPage() {
  const t = await getTranslations();
  const s = (key: string) => t(`platformConsole.settings.${key}`);
  const [settings, health, providers] = await Promise.all([
    fetchConsole('/settings', consoleSettingsSchema),
    fetchConsole('/providers/health', providerHealthSchema),
    fetchConsole('/payment-providers', paymentProviderListSchema),
  ]);

  return (
    <ConsoleFrame current="/settings" title={s('title')}>
      {settings === null || settings === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <>
          <Card>
            <ApiForm
              method="PUT"
              path="/api/console/settings"
              fields={[
                {
                  kind: 'textarea',
                  name: 'maintenanceBanner',
                  label: s('banner'),
                  rows: 2,
                  defaultValue: settings.maintenanceBanner,
                  emptyAs: 'null',
                },
                {
                  kind: 'number',
                  name: 'supportMaxHours',
                  label: s('supportMaxHours'),
                  defaultValue: settings.supportMaxHours,
                  required: true,
                },
                { kind: 'textarea', name: 'reason', label: s('reason'), rows: 2, required: true },
              ]}
              keepValues
              submitLabel={s('save')}
              successMessage={t('schoolAdmin.settings.saved')}
              texts={await formTexts()}
              reauth={await reauthTexts()}
              testId="console-settings"
            />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            {health !== null && health !== 'denied' ? (
              <Card>
                <h2 className="text-h3">{s('health')}</h2>
                <ul className="mt-2 flex flex-col divide-y divide-line">
                  {health.providers.map((provider) => (
                    <li
                      key={`${provider.kind}-${provider.name}`}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="flex flex-col">
                        <span className="text-label">{provider.name}</span>
                        <span className="text-caption text-muted">{provider.detail ?? provider.kind}</span>
                      </span>
                      <StatusBadge status={HEALTH_BADGES[provider.status]}>
                        {t(`platformConsole.settings.healthStatuses.${provider.status}`)}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            {providers !== null && providers !== 'denied' ? (
              <Card>
                <h2 className="text-h3">{s('paymentProviders')}</h2>
                <ul className="mt-2 flex flex-col divide-y divide-line">
                  {providers.providers.map((provider) => (
                    <li
                      key={provider.name}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="flex flex-col">
                        <span className="text-label">{provider.name}</span>
                        <span className="text-caption text-muted">{provider.note}</span>
                      </span>
                      <StatusBadge status={provider.approved ? 'published' : 'draft'}>
                        {provider.approved ? s('approved') : s('notApproved')}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        </>
      )}
    </ConsoleFrame>
  );
}
