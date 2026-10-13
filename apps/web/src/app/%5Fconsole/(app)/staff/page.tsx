import { staffListResponseSchema } from '@studyhub/contracts';
import { StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { StaffTable } from '../../../../components/console-forms';
import { ConsoleFrame } from '../../../../components/workspace-frames';
import { apiGet, getConsoleMe } from '../../../../lib/session';

export const metadata: Metadata = { title: 'Staff' };

/** S-C07 Staff: owners and operators see the list; only owners may disable (after re-authentication). */
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
    </ConsoleFrame>
  );
}
