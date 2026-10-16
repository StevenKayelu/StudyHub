import { brandingEditorSchema } from '@studyhub/contracts';
import { StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';

import { BrandingEditor, type BrandingTexts } from '../../../../../components/branding-editor';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchAdmin, formTexts } from '../../../../../lib/admin-api';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.branding'))('title') };
}

/** S-AD12 Branding (F39): draft, contrast check, preview, publish and version history. */
export default async function BrandingPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const data = await fetchAdmin('/api/v1/admin/branding', brandingEditorSchema);
  const versionLines =
    data === null || data === 'denied'
      ? {}
      : Object.fromEntries(
          data.versions.map((v) => [
            v.version,
            [
              t('schoolAdmin.branding.version', {
                version: v.version,
                date: format.dateTime(new Date(v.publishedAt), { dateStyle: 'medium', timeStyle: 'short' }),
              }),
              v.publishedBy === null ? null : t('schoolAdmin.branding.by', { name: v.publishedBy }),
            ]
              .filter(Boolean)
              .join(' '),
          ]),
        );

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/branding"
      title={t('schoolAdmin.branding.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/branding', label: t('schoolAdmin.branding.title') },
      ]}
    >
      <p className="max-w-reading text-body text-muted">{t('schoolAdmin.branding.intro')}</p>
      {data === null || data === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <BrandingEditor
          initial={data}
          locale={tenant.locales.defaultLocale}
          texts={{
            ...(await formTexts()),
            b: t.raw('schoolAdmin.branding') as BrandingTexts['b'],
            upload: t.raw('studio.upload') as Record<string, string>,
            close: t('schoolAdmin.actions.close'),
            cancel: t('schoolAdmin.actions.cancel'),
            versionLines,
          }}
        />
      )}
    </AdminFrame>
  );
}
