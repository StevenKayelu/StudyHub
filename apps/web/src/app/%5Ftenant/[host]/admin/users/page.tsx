import { adminUsersSchema } from '@studyhub/contracts';
import { Button, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

import { AdminFrame } from '../../../../../components/workspace-frames';
import { fetchAdmin } from '../../../../../lib/admin-api';
import { currentTenant } from '../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.users'))('title') };
}

type Search = Promise<Record<string, string | string[] | undefined>>;
const ROLES = ['LEARNER', 'INSTRUCTOR', 'TENANT_ADMIN', 'TENANT_OWNER'] as const;
const selectClasses = 'min-h-11 rounded-md border border-strong bg-surface px-3';

/** S-AD03 Users: search by name or email, filter by role and status (F30). */
export default async function AdminUsersPage({ searchParams }: { searchParams: Search }) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : undefined);
  const q = one('q')?.slice(0, 120);
  const role = ROLES.find((r) => r === one('role'));
  const status = one('status') === 'SUSPENDED' ? 'SUSPENDED' : undefined;
  const t = await getTranslations();
  const format = await getFormatter();
  const query = new URLSearchParams({
    ...(q !== undefined && q !== '' && { q }),
    ...(role !== undefined && { role }),
    ...(status !== undefined && { status }),
  });
  const result = await fetchAdmin(`/api/v1/admin/users?${query.toString()}`, adminUsersSchema);
  const roleNames = t.raw('auth.roleNames') as Record<string, string>;

  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/users"
      title={t('schoolAdmin.users.title')}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/users', label: t('schoolAdmin.users.title') },
      ]}
    >
      <form className="flex flex-wrap items-end gap-3" method="get" role="search">
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-label">
          {t('schoolAdmin.users.search')}
          <input name="q" type="search" defaultValue={q ?? ''} className={selectClasses} />
        </label>
        <label className="flex flex-col gap-1 text-label">
          {t('schoolAdmin.users.role')}
          <select name="role" defaultValue={role ?? ''} className={selectClasses}>
            <option value="">{t('schoolAdmin.users.anyRole')}</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleNames[r] ?? r}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label">
          {t('schoolAdmin.users.status')}
          <select name="status" defaultValue={status ?? ''} className={selectClasses}>
            <option value="">{t('schoolAdmin.users.anyStatus')}</option>
            <option value="SUSPENDED">{t('schoolAdmin.users.suspendedOnly')}</option>
          </select>
        </label>
        <Button type="submit" variant="secondary">
          {t('schoolAdmin.users.searchSubmit')}
        </Button>
      </form>

      {result === 'denied' ? (
        <StatePanel kind="permission" title={t('system.permission.title')} />
      ) : result === null || result.users.length === 0 ? (
        <StatePanel kind="empty" title={t('schoolAdmin.users.none')} />
      ) : (
        <>
          <p className="text-body-sm text-muted">{t('schoolAdmin.users.count', { count: result.total })}</p>
          <ul
            className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface"
            data-testid="users"
          >
            {result.users.map((user) => (
              <li key={user.membershipId} className="flex flex-wrap items-center gap-3 p-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <NextLink href={`/admin/users/${user.membershipId}`} className="text-label">
                    {user.displayName}
                  </NextLink>
                  <span className="text-body-sm break-all text-muted">{user.email}</span>
                  <span className="text-caption text-muted">
                    {user.lastActiveAt === null
                      ? t('schoolAdmin.users.never')
                      : t('schoolAdmin.users.lastActive', {
                          date: format.dateTime(new Date(user.lastActiveAt), { dateStyle: 'medium' }),
                        })}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {user.roles
                    .filter((r) => r !== 'LEARNER' || user.roles.length === 1)
                    .map((r) => (
                      <StatusBadge key={r} status={r === 'TENANT_OWNER' ? 'published' : 'draft'}>
                        {roleNames[r] ?? r}
                      </StatusBadge>
                    ))}
                  {user.status === 'SUSPENDED' ? (
                    <StatusBadge status="failed">{t('schoolAdmin.users.statuses.SUSPENDED')}</StatusBadge>
                  ) : null}
                  {!user.emailVerified ? (
                    <StatusBadge status="attention">{t('schoolAdmin.users.unverified')}</StatusBadge>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </AdminFrame>
  );
}
