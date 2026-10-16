import 'server-only';

import type { AuditEntry } from '@studyhub/contracts';
import { StatePanel } from '@studyhub/ui';
import { getFormatter, getTranslations } from 'next-intl/server';

const json = (value: unknown) =>
  value === null || value === undefined ? '—' : JSON.stringify(value, null, 2);

/** Audit entries (F34, S-AD10): who, what, when; each row expands to the before/after values. */
export async function AuditList({ entries }: { entries: AuditEntry[] }) {
  const t = await getTranslations('schoolAdmin.audit');
  const format = await getFormatter();
  if (entries.length === 0) return <StatePanel kind="empty" title={t('none')} />;
  return (
    <ul
      className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface"
      data-testid="audit-entries"
    >
      {entries.map((entry) => (
        <li key={entry.id} className="p-3">
          <details>
            <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-label">{entry.action}</span>
              <span className="text-body-sm text-muted">
                {entry.actorName ?? (entry.actorKind === 'SYSTEM' ? t('system') : '—')} ·{' '}
                {format.dateTime(new Date(entry.createdAt), { dateStyle: 'medium', timeStyle: 'medium' })}
              </span>
              <span className="text-caption text-muted">
                {entry.entityType}
                {entry.entityId === null ? '' : ` ${entry.entityId}`}
              </span>
            </summary>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <div>
                <p className="text-caption text-muted">{t('before')}</p>
                <pre className="overflow-x-auto rounded-md bg-sunken p-2 text-caption">
                  {json(entry.before)}
                </pre>
              </div>
              <div>
                <p className="text-caption text-muted">{t('after')}</p>
                <pre className="overflow-x-auto rounded-md bg-sunken p-2 text-caption">
                  {json(entry.after)}
                </pre>
              </div>
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
