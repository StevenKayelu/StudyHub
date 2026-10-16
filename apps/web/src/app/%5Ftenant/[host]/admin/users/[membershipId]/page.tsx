import { adminUserDetailSchema } from '@studyhub/contracts';
import { Card, formatMoney, StatePanel, StatusBadge } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { ActionButton } from '../../../../../../components/action-button';
import { AuditList } from '../../../../../../components/audit-list';
import { AdminFrame } from '../../../../../../components/workspace-frames';
import { actionTexts, fetchAdmin } from '../../../../../../lib/admin-api';
import { currentTenant } from '../../../../../../lib/tenant';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('schoolAdmin.users'))('title') };
}

type Params = Promise<{ membershipId: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;
const TABS = ['overview', 'enrolments', 'orders', 'sessions', 'audit'] as const;

/** S-AD03 user detail: overview, enrolments, orders, sessions and audit trail; suspend with a reason (F30). */
export default async function AdminUserPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const tenant = await currentTenant();
  if (tenant === null) return null;
  const { membershipId } = await params;
  const query = await searchParams;
  const tab = TABS.find((name) => name === query.tab) ?? 'overview';
  const t = await getTranslations();
  const format = await getFormatter();
  const locale = await getLocale();
  if (!/^[0-9a-f-]{36}$/i.test(membershipId)) notFound();
  const detail = await fetchAdmin(`/api/v1/admin/users/${membershipId}`, adminUserDetailSchema);
  if (detail === null) notFound();
  const texts = await actionTexts();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const roleNames = t.raw('auth.roleNames') as Record<string, string>;
  const tabClass = (current: boolean) =>
    `relative inline-flex min-h-11 items-center px-3 text-label no-underline ${current ? 'text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-full after:bg-accent' : 'text-muted'}`;

  if (detail === 'denied') {
    return (
      <AdminFrame tenant={tenant} current="/admin/users" title={t('schoolAdmin.users.title')}>
        <StatePanel kind="permission" title={t('system.permission.title')} />
      </AdminFrame>
    );
  }
  const { user } = detail;
  return (
    <AdminFrame
      tenant={tenant}
      current="/admin/users"
      title={user.displayName}
      breadcrumbs={[
        { href: '/admin', label: t('admin.navLabel') },
        { href: '/admin/users', label: t('schoolAdmin.users.title') },
        { href: `/admin/users/${user.membershipId}`, label: user.displayName },
      ]}
      headerActions={
        user.isSelf ? (
          <span className="text-body-sm text-muted">{t('schoolAdmin.users.self')}</span>
        ) : user.status === 'SUSPENDED' ? (
          <ActionButton
            label={t('schoolAdmin.users.unsuspend')}
            method="POST"
            path={`/api/v1/admin/users/${user.membershipId}/unsuspend`}
            texts={texts}
            testId="unsuspend"
            confirm={{
              title: t('schoolAdmin.users.unsuspendTitle', { name: user.displayName }),
              confirmLabel: t('schoolAdmin.users.unsuspend'),
              reasonLabel: t('schoolAdmin.actions.reason'),
            }}
          />
        ) : (
          <ActionButton
            label={t('schoolAdmin.users.suspend')}
            method="POST"
            path={`/api/v1/admin/users/${user.membershipId}/suspend`}
            variant="danger"
            texts={texts}
            testId="suspend"
            confirm={{
              title: t('schoolAdmin.users.suspendTitle', { name: user.displayName }),
              description: t('schoolAdmin.users.suspendBody'),
              confirmLabel: t('schoolAdmin.users.suspend'),
              reasonLabel: t('schoolAdmin.actions.reason'),
            }}
          />
        )
      }
    >
      <nav aria-label={user.displayName} className="flex flex-wrap gap-2 border-b border-line">
        {TABS.map((name) => (
          <NextLink
            key={name}
            href={`/admin/users/${user.membershipId}${name === 'overview' ? '' : `?tab=${name}`}`}
            className={tabClass(tab === name)}
            aria-current={tab === name ? 'page' : undefined}
          >
            {t(`schoolAdmin.users.tabs.${name}`)}
          </NextLink>
        ))}
      </nav>

      {tab === 'overview' ? (
        <Card>
          <dl className="grid gap-3 md:grid-cols-2">
            <div>
              <dt className="text-caption text-muted">{t('auth.email')}</dt>
              <dd className="text-body break-all">{user.email}</dd>
            </div>
            <div>
              <dt className="text-caption text-muted">{t('schoolAdmin.users.status')}</dt>
              <dd className="flex flex-wrap gap-1">
                <StatusBadge status={user.status === 'ACTIVE' ? 'published' : 'failed'}>
                  {t(`schoolAdmin.users.statuses.${user.status}`)}
                </StatusBadge>
                <StatusBadge status={user.emailVerified ? 'published' : 'attention'}>
                  {user.emailVerified ? t('schoolAdmin.users.verified') : t('schoolAdmin.users.unverified')}
                </StatusBadge>
              </dd>
            </div>
            <div>
              <dt className="text-caption text-muted">{t('schoolAdmin.users.role')}</dt>
              <dd className="text-body">{user.roles.map((r) => roleNames[r] ?? r).join(', ')}</dd>
            </div>
            <div>
              <dt className="text-caption text-muted">{t('schoolAdmin.users.tabs.sessions')}</dt>
              <dd className="text-body">
                {user.lastActiveAt === null
                  ? t('schoolAdmin.users.never')
                  : t('schoolAdmin.users.lastActive', { date: date(user.lastActiveAt) })}
              </dd>
            </div>
          </dl>
          {!user.emailVerified ? (
            <div className="mt-4">
              <ActionButton
                label={t('schoolAdmin.users.resend')}
                method="POST"
                path={`/api/v1/admin/users/${user.membershipId}/resend-verification`}
                texts={texts}
                doneLabel={t('schoolAdmin.users.resent')}
              />
            </div>
          ) : null}
          <p className="mt-4 text-body-sm text-muted">{t('schoolAdmin.users.grantHint')}</p>
        </Card>
      ) : null}

      {tab === 'enrolments' ? (
        detail.enrollments.length === 0 ? (
          <StatePanel kind="empty" title={t('schoolAdmin.users.noEnrolments')} />
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {detail.enrollments.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <NextLink href={`/admin/courses/${e.courseId}/access`} className="text-label">
                  {e.courseTitle}
                </NextLink>
                <span className="text-body-sm text-muted">
                  {e.status} · {e.source} · {t('schoolAdmin.users.enrolledAt', { date: date(e.enrolledAt) })}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {tab === 'orders' ? (
        detail.orders.length === 0 ? (
          <StatePanel kind="empty" title={t('schoolAdmin.users.noOrders')} />
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {detail.orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <NextLink href={`/admin/orders/${o.id}`} className="text-label">
                  {o.courseTitle}
                </NextLink>
                <span className="tabular text-body-sm text-muted">
                  {formatMoney(o.amountMinor, o.currency, locale)} ·{' '}
                  {t(`commerce.orderStatuses.${o.status as 'PAID'}`)} · {date(o.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {tab === 'sessions' ? (
        detail.sessions.length === 0 ? (
          <StatePanel kind="empty" title={t('schoolAdmin.users.noSessions')} />
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {detail.sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="flex min-w-0 flex-col">
                  <span className="text-body-sm break-all">{s.userAgent ?? '—'}</span>
                  <span className="text-caption text-muted">
                    {t('schoolAdmin.users.sessionAt', {
                      created: date(s.createdAt),
                      seen: date(s.lastSeenAt),
                    })}
                  </span>
                </div>
                <ActionButton
                  label={t('schoolAdmin.users.revokeSession')}
                  method="DELETE"
                  path={`/api/v1/admin/users/${user.membershipId}/sessions/${s.id}`}
                  texts={texts}
                />
              </li>
            ))}
          </ul>
        )
      ) : null}

      {tab === 'audit' ? <AuditList entries={detail.audit} /> : null}
    </AdminFrame>
  );
}
