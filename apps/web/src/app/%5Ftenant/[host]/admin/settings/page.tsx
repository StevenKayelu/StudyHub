import { adminSettingsSchema } from '@studyhub/contracts';
import { Card } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { PaymentSettingsForm } from '../../../../../components/payment-settings-form';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { commerceTexts } from '../../../../../lib/commerce-texts';
import { fetchContent } from '../../../../../lib/content-api';
import { currentTenant, getTerms } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('commerce.admin.settings'))('title') };
}

/** S-AD09 Settings. M8 brings the Payments group (BR-62); the other groups arrive with M9. */
export default async function AdminSettingsPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations('commerce.admin.settings');
  const format = await getFormatter();
  const settings = await fetchContent('/api/v1/admin/settings', adminSettingsSchema);
  if (settings === null) return null;
  const last = settings.lastChange;
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/settings"
      title={t('title')}
      breadcrumbs={[{ href: '/admin/settings', label: t('title') }]}
    >
      {last !== null ? (
        <Card>
          <p className="text-body-sm text-muted">
            {t('lastChange', {
              time: format.dateTime(new Date(last.at), { dateStyle: 'medium', timeStyle: 'short' }),
              name: last.by ?? '—',
              reason: last.reason ?? '',
            })}
          </p>
        </Card>
      ) : null}
      <PaymentSettingsForm
        initial={settings}
        texts={await commerceTexts(await getTerms(tenant, await getLocale()))}
      />
    </AdminFrame>
  );
}
