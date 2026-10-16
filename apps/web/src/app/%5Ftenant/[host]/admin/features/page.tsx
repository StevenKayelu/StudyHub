import { adminFeaturesSchema } from '@studyhub/contracts';
import { StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../../components/action-button';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { actionTexts, fetchAdmin } from '../../../../../lib/admin-api';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.features'))('title') };
}

/**
 * S-AD13 Features (F40): what the plan includes, what the platform added, and the school's own switch.
 * Turning a feature off says what happens and needs a confirmation; its data is kept.
 */
export default async function FeaturesPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const data = await fetchAdmin('/api/v1/admin/features', adminFeaturesSchema);
  const texts = await actionTexts();
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/features"
      title={t('schoolAdmin.features.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/features', label: t('schoolAdmin.features.title') },
      ]}
    >
      <p className="max-w-reading text-body text-muted">{t('schoolAdmin.features.intro')}</p>
      {data === 'denied' || data === null ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <ul
          className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface"
          data-testid="features"
        >
          {data.features.map((feature) => {
            const name = t(`schoolAdmin.features.names.${feature.key}`);
            return (
              <li
                key={feature.key}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
                data-feature={feature.key}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-label">{name}</span>
                  <span className="text-body-sm text-muted">
                    {feature.later
                      ? t('schoolAdmin.features.later')
                      : feature.override === 'GRANT'
                        ? t('schoolAdmin.features.granted')
                        : feature.available
                          ? t('schoolAdmin.features.included')
                          : t('schoolAdmin.features.notInPlan')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={feature.effective ? 'published' : 'draft'}>
                    {feature.effective ? t('schoolAdmin.features.on') : t('schoolAdmin.features.off')}
                  </StatusBadge>
                  {feature.later || !feature.available ? null : feature.enabledByTenant ? (
                    <ActionButton
                      label={t('schoolAdmin.features.turnOff')}
                      method="PUT"
                      path={`/api/v1/admin/features/${feature.key}`}
                      body={{ enabled: false }}
                      texts={texts}
                      testId={`feature-off-${feature.key}`}
                      confirm={{
                        title: t('schoolAdmin.features.turnOffTitle', { feature: name }),
                        description: t('schoolAdmin.features.turnOffBody', {
                          consequence: t(`schoolAdmin.features.consequences.${feature.key}`),
                        }),
                        confirmLabel: t('schoolAdmin.features.turnOff'),
                      }}
                    />
                  ) : (
                    <ActionButton
                      label={t('schoolAdmin.features.turnOn')}
                      method="PUT"
                      path={`/api/v1/admin/features/${feature.key}`}
                      body={{ enabled: true }}
                      variant="primary"
                      texts={texts}
                      testId={`feature-on-${feature.key}`}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </AdminFrame>
  );
}
