import { StatePanel } from '@studyhub/ui';
import { getTranslations } from 'next-intl/server';

import { ConsoleFrame } from '../../../components/workspace-frames';

/** S-C02 Overview: the console shell. Data and access control arrive with the console milestones. */
export default async function ConsoleOverviewPage() {
  const t = await getTranslations('console');
  return (
    <ConsoleFrame title={t('title')}>
      <StatePanel kind="empty" title={t('emptyTitle')} message={t('emptyMessage')} />
    </ConsoleFrame>
  );
}
