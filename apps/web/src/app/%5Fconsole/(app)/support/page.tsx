import {
  consoleSettingsSchema,
  consoleSupportGrantListSchema,
  consoleTenantListSchema,
  DEFAULT_CONSOLE_SETTINGS,
} from '@studyhub/contracts';
import { Card, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ConsoleGrantList, SupportRequestForm } from '../../../../components/console-support';
import { ConsoleFrame } from '../../../../components/workspace-frames';
import { fetchConsole } from '../../../../lib/admin-api';
import { getConsoleMe } from '../../../../lib/session';

export const metadata: Metadata = { title: 'Support access' };

/** F44 for staff: request time-limited access to a school, open it once approved, end it early. */
export default async function ConsoleSupportPage() {
  const t = await getTranslations();
  const me = await getConsoleMe();
  const [grants, tenants, settings] = await Promise.all([
    fetchConsole('/support-access', consoleSupportGrantListSchema),
    fetchConsole('/tenants', consoleTenantListSchema),
    me?.role === 'PLATFORM_OWNER' ? fetchConsole('/settings', consoleSettingsSchema) : Promise.resolve(null),
  ]);
  const maxHours =
    settings === null || settings === 'denied'
      ? DEFAULT_CONSOLE_SETTINGS.supportMaxHours
      : settings.supportMaxHours;
  const reachable =
    tenants === null || tenants === 'denied'
      ? []
      : tenants.tenants.filter((tenant) => ['ACTIVE', 'SUSPENDED', 'PROVISIONING'].includes(tenant.status));

  return (
    <ConsoleFrame current="/support" title={t('platformConsole.support.title')}>
      <p className="max-w-reading text-body text-muted">{t('platformConsole.support.intro')}</p>
      {grants === null || grants === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <>
          {reachable.length > 0 ? (
            <Card>
              <h2 className="text-h3">{t('platformConsole.detail.requestSupport')}</h2>
              <div className="mt-3">
                <SupportRequestForm
                  tenants={reachable.map((tenant) => ({ id: tenant.id, name: tenant.name }))}
                  maxHours={maxHours}
                />
              </div>
            </Card>
          ) : null}
          <Card>
            <h2 className="text-h3">{t('platformConsole.support.mine')}</h2>
            <div className="mt-2">
              <ConsoleGrantList grants={grants.grants} showTenant />
            </div>
          </Card>
        </>
      )}
    </ConsoleFrame>
  );
}
