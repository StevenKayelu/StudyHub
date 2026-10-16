import { exportListSchema, offboardingSchema } from '@studyhub/contracts';
import { Alert, Card, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../../components/action-button';
import { ExportList } from '../../../../../components/export-list';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { actionTexts, fetchAdmin } from '../../../../../lib/admin-api';
import { getMe } from '../../../../../lib/session';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.data'))('title') };
}

/**
 * S-AD18 Data & offboarding (F46, BR-52, BR-53): the full export and closing the school. Owners only;
 * it stays reachable while the school is read-only during the grace period, to export and cancel.
 */
export default async function DataPage() {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const t = await getTranslations();
  const format = await getFormatter();
  const me = await getMe();
  const owner = me?.membership.roles.includes('TENANT_OWNER') === true && me.support === null;
  const texts = await actionTexts();
  const [offboarding, exports] = owner
    ? await Promise.all([
        fetchAdmin('/api/v1/admin/offboarding', offboardingSchema),
        fetchAdmin('/api/v1/admin/exports', exportListSchema),
      ])
    : [null, null];
  const fullExports =
    exports === null || exports === 'denied' ? [] : exports.exports.filter((e) => e.type === 'TENANT_FULL');
  const closing = offboarding !== null && offboarding !== 'denied' && offboarding.status === 'OFFBOARDING';

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/data"
      title={t('schoolAdmin.data.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/data', label: t('schoolAdmin.data.title') },
      ]}
    >
      {!owner ? (
        <StatePanel kind="permission" title={t('schoolAdmin.data.onlyOwner')} />
      ) : (
        <>
          {closing && offboarding.deleteAfter !== null ? (
            <Alert
              tone="warning"
              title={t('schoolAdmin.data.offboarding', {
                date: format.dateTime(new Date(offboarding.deleteAfter), { dateStyle: 'long' }),
              })}
            />
          ) : null}
          <Card>
            <h2 className="text-h3">{t('schoolAdmin.data.exportTitle')}</h2>
            <p className="mt-2 max-w-reading text-body text-muted">{t('schoolAdmin.data.exportBody')}</p>
            <div className="mt-3">
              {tenant.features.dataExport ? (
                <ActionButton
                  label={t('schoolAdmin.data.exportRequest')}
                  method="POST"
                  path="/api/v1/admin/exports/tenant"
                  variant="primary"
                  texts={texts}
                  testId="request-full-export"
                />
              ) : (
                <p className="text-body-sm text-muted">{t('schoolAdmin.data.exportDisabled')}</p>
              )}
            </div>
            {fullExports.length > 0 ? (
              <div className="mt-4">
                <ExportList exports={fullExports} />
              </div>
            ) : null}
          </Card>
          <Card>
            <h2 className="text-h3">{t('schoolAdmin.data.offboardTitle')}</h2>
            <p className="mt-2 max-w-reading text-body text-muted">
              {t('schoolAdmin.data.offboardBody', {
                days: offboarding !== null && offboarding !== 'denied' ? offboarding.graceDays : 30,
              })}
            </p>
            <div className="mt-3">
              {closing ? (
                <ActionButton
                  label={t('schoolAdmin.data.cancel')}
                  method="DELETE"
                  path="/api/v1/admin/offboarding"
                  variant="primary"
                  texts={texts}
                  then="reload"
                  testId="cancel-offboarding"
                />
              ) : (
                <ActionButton
                  label={t('schoolAdmin.data.offboard')}
                  method="POST"
                  path="/api/v1/admin/offboarding"
                  variant="danger"
                  texts={texts}
                  then="reload"
                  testId="offboard"
                  confirm={{
                    title: t('schoolAdmin.data.offboardDialog', { name: tenant.name }),
                    description: t('schoolAdmin.data.offboardBody', {
                      days: offboarding !== null && offboarding !== 'denied' ? offboarding.graceDays : 30,
                    }),
                    confirmLabel: t('schoolAdmin.data.offboard'),
                    typeToConfirm: {
                      label: t('schoolAdmin.data.typeName'),
                      value: tenant.name,
                      field: 'confirmName',
                    },
                  }}
                />
              )}
            </div>
          </Card>
        </>
      )}
    </AdminFrame>
  );
}
