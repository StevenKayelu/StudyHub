import { auditPageSchema } from '@studyhub/contracts';
import { Button, buttonClasses, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getTranslations } from 'next-intl/server';

import { AuditList } from '../../../../../components/audit-list';
import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchAdmin } from '../../../../../lib/admin-api';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.audit'))('title') };
}

type Search = Promise<Record<string, string | string[] | undefined>>;
const field = 'min-h-11 rounded-md border border-strong bg-surface px-3';

/** S-AD10 Audit log: the school's own trail (F34, F49), filtered by action, record type and dates. */
export default async function AuditLogPage({ searchParams }: { searchParams: Search }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const params = await searchParams;
  const one = (key: string) =>
    typeof params[key] === 'string' ? (params[key] as string).slice(0, 80) : undefined;
  const filters = {
    action: one('action'),
    entityType: one('entityType'),
    from: /^\d{4}-\d{2}-\d{2}$/.test(one('from') ?? '') ? one('from') : undefined,
    to: /^\d{4}-\d{2}-\d{2}$/.test(one('to') ?? '') ? one('to') : undefined,
    before: /^\d+$/.test(one('before') ?? '') ? one('before') : undefined,
  };
  const query = new URLSearchParams(
    Object.entries(filters).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
    ),
  );
  const t = await getTranslations();
  const page = await fetchAdmin(`/api/v1/admin/audit-log?${query.toString()}`, auditPageSchema);
  const older = new URLSearchParams(query);
  if (page !== null && page !== 'denied' && page.nextBefore !== null) older.set('before', page.nextBefore);
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/audit-log"
      title={t('schoolAdmin.audit.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/audit-log', label: t('schoolAdmin.audit.title') },
      ]}
    >
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="flex flex-col gap-1 text-label">
          {t('schoolAdmin.audit.action')}
          <input
            name="action"
            defaultValue={filters.action ?? ''}
            placeholder="settings."
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-label">
          {t('schoolAdmin.audit.entity')}
          <input name="entityType" defaultValue={filters.entityType ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-label">
          {t('schoolAdmin.audit.from')}
          <input type="date" name="from" defaultValue={filters.from ?? ''} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-label">
          {t('schoolAdmin.audit.to')}
          <input type="date" name="to" defaultValue={filters.to ?? ''} className={field} />
        </label>
        <Button type="submit" variant="secondary">
          {t('schoolAdmin.audit.filter')}
        </Button>
      </form>
      {page === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : (
        <>
          <AuditList entries={page?.entries ?? []} />
          {page !== null && page.nextBefore !== null ? (
            <NextLink
              href={`/admin/audit-log?${older.toString()}`}
              className={buttonClasses('secondary', 'sm')}
            >
              {t('schoolAdmin.audit.older')}
            </NextLink>
          ) : null}
        </>
      )}
    </AdminFrame>
  );
}
