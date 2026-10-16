import { consoleAuditPageSchema } from '@studyhub/contracts';
import { Button, buttonClasses, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getTranslations } from 'next-intl/server';

import { AuditList } from '../../../../components/audit-list';
import { ConsoleFrame } from '../../../../components/workspace-frames';
import { fetchConsole } from '../../../../lib/admin-api';

export const metadata: Metadata = { title: 'Audit log' };

type Search = Promise<Record<string, string | string[] | undefined>>;
const field = 'min-h-11 rounded-md border border-strong bg-surface px-3';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** S-C09 Platform audit log (F49, platform owner): every console mutation, filtered by school or action. */
export default async function ConsoleAuditPage({ searchParams }: { searchParams: Search }) {
  const t = await getTranslations();
  const a = (key: string) => t(`platformConsole.audit.${key}`);
  const params = await searchParams;
  const one = (key: string) =>
    typeof params[key] === 'string' ? (params[key] as string).trim().slice(0, 80) : '';
  const filters = {
    tenantId: UUID.test(one('tenantId')) ? one('tenantId') : '',
    action: one('action'),
    before: /^\d+$/.test(one('before')) ? one('before') : '',
  };
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== ''));
  const page = await fetchConsole(`/audit-log?${query.toString()}`, consoleAuditPageSchema);
  const older = new URLSearchParams(query);
  if (page !== null && page !== 'denied' && page.nextBefore !== null) older.set('before', page.nextBefore);

  return (
    <ConsoleFrame current="/audit-log" title={a('title')}>
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="flex flex-col gap-1 text-label">
          {a('tenant')}
          <input name="tenantId" defaultValue={filters.tenantId} placeholder="uuid" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-label">
          {a('action')}
          <input name="action" defaultValue={filters.action} placeholder="tenant." className={field} />
        </label>
        <Button type="submit" variant="secondary">
          {a('filter')}
        </Button>
      </form>
      {page === null || page === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <>
          <AuditList
            entries={page.entries.map((entry) => ({
              ...entry,
              entityType:
                entry.tenantId === null ? entry.entityType : `${entry.entityType} · ${entry.tenantId}`,
              actorKind: entry.actorName === null ? ('SYSTEM' as const) : ('STAFF' as const),
            }))}
          />
          {page.nextBefore !== null ? (
            <NextLink href={`/audit-log?${older.toString()}`} className={buttonClasses('secondary', 'sm')}>
              {a('older')}
            </NextLink>
          ) : null}
        </>
      )}
    </ConsoleFrame>
  );
}
