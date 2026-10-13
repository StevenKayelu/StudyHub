import { Card } from '@studyhub/ui';
import { getTranslations } from 'next-intl/server';

import { getSystemStatus } from '../lib/server-api';

// Always reflect the live state; never serve a cached status.
export const dynamic = 'force-dynamic';

export default async function SystemStatusPage() {
  const status = await getSystemStatus();
  const t = await getTranslations('status');
  const rows: [string, string, string][] = [
    [t('api'), status.api, 'api-status'],
    [t('database'), status.database, 'database-status'],
    [t('version'), status.version ?? t('unknown'), 'api-version'],
  ];

  return (
    <main id="content" className="mx-auto flex max-w-reading flex-col gap-4 px-4 py-8">
      <h1 className="text-h1">{t('title')}</h1>
      <p className="text-body text-muted">{t('intro')}</p>
      <Card>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          {rows.map(([label, value, testId]) => (
            <div key={testId} className="contents">
              <dt className="text-label text-muted">{label}</dt>
              <dd className="tabular text-body" data-testid={testId}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </main>
  );
}
