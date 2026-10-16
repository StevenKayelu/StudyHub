import 'server-only';

import type { ExportView } from '@studyhub/contracts';
import { buttonClasses, StatePanel, StatusBadge } from '@studyhub/ui';
import { getFormatter, getTranslations } from 'next-intl/server';

const BADGES = {
  QUEUED: 'pending',
  RUNNING: 'pending',
  READY: 'published',
  FAILED: 'failed',
  EXPIRED: 'draft',
} as const;

/** Exports with their status and a download link while ready (7 days). */
export async function ExportList({ exports }: { exports: ExportView[] }) {
  const t = await getTranslations('schoolAdmin.reports');
  const format = await getFormatter();
  if (exports.length === 0) return <StatePanel kind="empty" title={t('noExports')} />;
  return (
    <ul
      className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface"
      data-testid="exports"
    >
      {exports.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="flex flex-col">
            <span className="text-label">{t(`exportTypes.${item.type}`)}</span>
            <span className="text-caption text-muted">
              {item.params.from !== undefined ? `${item.params.from} – ${item.params.to ?? ''} · ` : ''}
              {format.dateTime(new Date(item.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
              {item.rowCount !== null ? ` · ${t('rows', { count: item.rowCount })}` : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={BADGES[item.status]}>{t(`exportStatuses.${item.status}`)}</StatusBadge>
            {item.status === 'READY' ? (
              <a href={`/admin/exports/${item.id}/download`} className={buttonClasses('secondary', 'sm')}>
                {t('download')}
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
