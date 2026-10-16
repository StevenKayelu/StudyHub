import { platformRoleSchema, staffListResponseSchema } from '@studyhub/contracts';
import { Card, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../components/action-button';
import { ApiForm } from '../../../../components/api-form';
import { StaffTable } from '../../../../components/console-forms';
import { ConsoleFrame } from '../../../../components/workspace-frames';
import { actionTexts, formTexts, reauthTexts } from '../../../../lib/admin-api';
import { apiGet, getConsoleMe } from '../../../../lib/session';

export const metadata: Metadata = { title: 'Staff' };

/**
 * S-C07 Staff: owners and operators see the list; only owners create accounts (PROPOSED 8: with an
 * initial password, TOTP enrolment forced at first sign-in), change roles and disable, after re-authentication.
 */
export default async function StaffPage() {
  const t = await getTranslations();
  const me = await getConsoleMe();
  if (me === null) return null;
  const response = await apiGet('/console/staff');
  if (response.status === 403) {
    return (
      <ConsoleFrame current="/staff" title={t('console.staff.title')}>
        <StatePanel kind="permission" title={t('system.permission.title')} />
      </ConsoleFrame>
    );
  }
  const { staff } = staffListResponseSchema.parse(await response.json());
  const owner = me.role === 'PLATFORM_OWNER';
  const roleNames = t.raw('console.staff.roles') as Record<string, string>;
  const roleOptions = platformRoleSchema.options.map((role) => ({
    value: role,
    label: roleNames[role] ?? role,
  }));
  const texts = await actionTexts();
  const a = (key: string) => t(`platformConsole.staffAdmin.${key}`);
  return (
    <ConsoleFrame current="/staff" title={t('console.staff.title')}>
      <StaffTable
        staff={staff}
        selfId={me.id}
        canDisable={me.role === 'PLATFORM_OWNER'}
        texts={{
          ...{ errorSummary: t('common.errorSummary'), networkError: t('common.networkError') },
          email: t('console.staff.email'),
          role: t('console.staff.role'),
          twoStep: t('console.staff.twoStep'),
          on: t('console.staff.on'),
          off: t('console.staff.off'),
          disable: t('console.staff.disable'),
          disabled: t('console.staff.disabled'),
          active: t('console.staff.active'),
          reauthTitle: t('console.staff.reauthTitle'),
          reauthBody: t('console.staff.reauthBody'),
          code: t('console.verify.code'),
          submit: t('console.verify.submit'),
          close: t('common.close'),
          roleNames: t.raw('console.staff.roles') as Record<string, string>,
        }}
      />
      {owner ? (
        <>
          <Card>
            <h2 className="text-h3">{a('changeRole')}</h2>
            <ul className="mt-2 flex flex-col divide-y divide-line">
              {staff
                .filter((member) => member.id !== me.id && member.status === 'ACTIVE')
                .map((member) => (
                  <li key={member.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="text-label">
                      {member.displayName} · {roleNames[member.role]}
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {roleOptions
                        .filter((role) => role.value !== member.role)
                        .map((role) => (
                          <ActionButton
                            key={role.value}
                            label={role.label}
                            method="PATCH"
                            path={`/api/console/staff/${member.id}`}
                            body={{ role: role.value }}
                            texts={texts}
                            testId={`staff-role-${role.value}`}
                            confirm={{
                              title: `${a('changeRole')}: ${member.displayName} → ${role.label}`,
                              confirmLabel: a('saveRole'),
                            }}
                          />
                        ))}
                    </span>
                  </li>
                ))}
            </ul>
          </Card>
          <Card>
            <h2 className="text-h3">{a('add')}</h2>
            <div className="mt-3">
              <ApiForm
                method="POST"
                path="/api/console/staff"
                columns={2}
                fields={[
                  { kind: 'email', name: 'email', label: a('email'), required: true },
                  { kind: 'text', name: 'displayName', label: a('name'), required: true },
                  {
                    kind: 'select',
                    name: 'role',
                    label: a('role'),
                    options: roleOptions,
                    defaultValue: 'PLATFORM_SUPPORT',
                  },
                  {
                    kind: 'password',
                    name: 'password',
                    label: a('password'),
                    autoComplete: 'new-password',
                    required: true,
                  },
                ]}
                submitLabel={a('create')}
                texts={await formTexts()}
                reauth={await reauthTexts()}
                testId="create-staff"
              />
            </div>
          </Card>
        </>
      ) : null}
    </ConsoleFrame>
  );
}
