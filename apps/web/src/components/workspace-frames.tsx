import 'server-only';

import {
  notificationListSchema,
  queueSummarySchema,
  type QueueSummary,
  type TenantBootstrap,
} from '@studyhub/contracts';
import { Banner, type ShellNavItem, WorkspaceShell, type WorkspaceShellProps } from '@studyhub/ui';
import {
  Bell,
  BookCheck,
  Building2,
  ChartColumn,
  ClipboardList,
  CreditCard,
  Database,
  FileText,
  FolderTree,
  Gauge,
  Globe,
  GraduationCap,
  Landmark,
  LayoutDashboard,
  LifeBuoy,
  Library,
  ListChecks,
  Palette,
  Receipt,
  Scale,
  ScrollText,
  Settings,
  ToggleRight,
  UserRound,
  UserRoundCog,
  Users,
  UsersRound,
  Wallet,
  Waypoints,
} from 'lucide-react';
import NextLink from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { apiGet, getConsoleMe, getMe } from '../lib/session';
import { getTerms } from '../lib/tenant';
import { SignOutButton } from './sign-out-button';
import { SupportBanner } from './support-banner';

const icon = 'size-5 shrink-0';

const brandOf = (tenant: TenantBootstrap) => ({
  name: tenant.branding.displayName,
  href: '/',
  ...(tenant.branding.logoAssetId !== null && {
    logoSrc: `/api/v1/tenant/brand/${tenant.branding.logoAssetId}`,
  }),
});

type FrameProps = Pick<WorkspaceShellProps, 'title' | 'headerActions' | 'breadcrumbs' | 'children'> & {
  /** Which navigation item is current (defaults to the first). */
  current?: string;
};

/** Unread notifications (F33) of the signed-in member; 0 when unavailable. */
async function unreadCount(): Promise<number> {
  try {
    const response = await apiGet('/api/v1/me/notifications');
    if (!response.ok) return 0;
    return notificationListSchema.parse(await response.json()).unread;
  } catch {
    return 0;
  }
}

/** Name, notifications, account link and sign-out for the signed-in school member. */
async function SchoolAccountMenu() {
  const me = await getMe();
  if (me === null) return null;
  const t = await getTranslations();
  if (me.support !== null) return <span className="text-label text-muted">{me.user.displayName}</span>;
  const unread = await unreadCount();
  return (
    <div className="flex items-center gap-2">
      <NextLink
        href="/account/notifications"
        aria-label={t('schoolAdmin.notifications.bell', { count: unread })}
        className="relative inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink"
        data-testid="notifications-bell"
      >
        <Bell aria-hidden="true" className="size-5" strokeWidth={1.5} />
        {unread > 0 ? (
          <span className="absolute right-1.5 top-1.5 min-w-5 rounded-full bg-accent px-1 text-center text-caption text-on-accent tabular">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </NextLink>
      <NextLink href="/account" className="hidden text-label text-ink no-underline md:inline">
        {me.user.displayName}
      </NextLink>
      <SignOutButton label={t('common.signOut')} />
    </div>
  );
}

/** The platform's maintenance notice (S-C08) and, in a support session, the F44 banner. */
async function SchoolBanners({ tenant }: { tenant: TenantBootstrap }): Promise<ReactNode> {
  const t = await getTranslations();
  const format = await getFormatter();
  const me = await getMe();
  const support = me?.support ?? null;
  if (tenant.notice === null && support === null) return null;
  return (
    <>
      {tenant.notice !== null ? (
        <Banner tone="info">
          <span className="sr-only">{t('schoolAdmin.noticeLabel')}: </span>
          {tenant.notice}
        </Banner>
      ) : null}
      {support !== null ? (
        <SupportBanner
          endLabel={t('schoolAdmin.endSupport')}
          message={t('schoolAdmin.supportBanner', {
            name: support.staffName,
            scope: t(`schoolAdmin.supportScope.${support.scope}`),
            time: format.dateTime(new Date(support.expiresAt), { timeStyle: 'short' }),
          })}
        />
      ) : null}
    </>
  );
}

const markCurrent = <T extends { href: string }>(items: T[], current: string | undefined) =>
  items.map((item, index) => ({
    ...item,
    current: current === undefined ? index === 0 : item.href === current,
  }));

/** Studio, the tutor workspace (06 §1.4). */
export async function StudioFrame({ tenant, current, ...props }: FrameProps & { tenant: TenantBootstrap }) {
  const locale = await getLocale();
  const t = await getTranslations();
  const terms = await getTerms(tenant, locale);
  return (
    <WorkspaceShell
      variant="studio"
      brand={brandOf(tenant)}
      navLabel={t('studio.navLabel')}
      skipLabel={t('common.skipToContent')}
      menuLabel={t('common.menu')}
      closeLabel={t('common.close')}
      breadcrumbLabel={t('common.breadcrumb')}
      accountMenu={<SchoolAccountMenu />}
      banner={<SchoolBanners tenant={tenant} />}
      nav={markCurrent(
        [
          {
            href: '/studio',
            label: t('studio.nav.courses', terms),
            icon: <Library aria-hidden="true" className={icon} />,
          },
          {
            href: '/studio/results',
            label: t('studio.nav.results'),
            icon: <ChartColumn aria-hidden="true" className={icon} />,
          },
          {
            href: '/studio/earnings',
            label: t('studio.nav.earnings'),
            icon: <CreditCard aria-hidden="true" className={icon} />,
          },
          {
            href: '/studio/profile',
            label: t('studio.nav.profile'),
            icon: <UserRound aria-hidden="true" className={icon} />,
          },
        ],
        current,
      )}
      {...props}
    />
  );
}

/** Queue counts for the navigation badges (F31 AC). Never fails the page. */
async function queues(): Promise<QueueSummary['queues']> {
  try {
    const response = await apiGet('/api/v1/admin/queues/summary');
    return response.ok ? queueSummarySchema.parse(await response.json()).queues : [];
  } catch {
    return [];
  }
}

/** Tenant administration (06 §1.4, §10.2). Owner-only areas appear for owners only. */
export async function AdminFrame({ tenant, current, ...props }: FrameProps & { tenant: TenantBootstrap }) {
  const t = await getTranslations();
  const terms = await getTerms(tenant, await getLocale());
  const me = await getMe();
  const owner = me?.membership.roles.includes('TENANT_OWNER') === true && me.support === null;
  const counts = new Map((await queues()).map((queue) => [queue.key, queue]));
  const badge = (...keys: Parameters<typeof counts.get>[0][]) => {
    const total = keys.reduce((sum, key) => sum + (counts.get(key)?.count ?? 0), 0);
    if (total === 0) return {};
    const overdue = keys.some((key) => counts.get(key)?.overdue === true);
    return { badge: String(total), badgeTone: overdue ? ('warning' as const) : ('neutral' as const) };
  };
  const item = (href: string, label: string, Icon: typeof Users, extra: Partial<ShellNavItem> = {}) => ({
    href,
    label,
    icon: <Icon aria-hidden="true" className={icon} />,
    ...extra,
  });
  return (
    <WorkspaceShell
      variant="admin"
      brand={brandOf(tenant)}
      navLabel={t('admin.navLabel')}
      skipLabel={t('common.skipToContent')}
      menuLabel={t('common.menu')}
      closeLabel={t('common.close')}
      breadcrumbLabel={t('common.breadcrumb')}
      accountMenu={<SchoolAccountMenu />}
      banner={<SchoolBanners tenant={tenant} />}
      nav={markCurrent(
        [
          item('/admin', t('admin.nav.overview'), LayoutDashboard),
          item('/admin/users', t('schoolAdmin.nav.users'), Users),
          item('/admin/team', t('schoolAdmin.nav.team'), UsersRound),
          item('/admin/reviews', t('admin.nav.reviews'), ListChecks, badge('reviews')),
          item('/admin/courses', t('admin.nav.courses', terms), BookCheck),
          item('/admin/categories', t('admin.nav.categories'), FolderTree),
          item('/admin/instructors', t('admin.nav.instructors', terms), GraduationCap, badge('applications')),
          item('/admin/orders', t('admin.nav.orders'), Receipt, badge('paymentExceptions')),
          item('/admin/payouts', t('admin.nav.payouts'), Wallet),
          item('/admin/payments', t('admin.nav.payments'), Landmark),
          item('/admin/reconciliation', t('schoolAdmin.nav.reconciliation'), Scale, badge('settlement')),
          item('/admin/reports', t('schoolAdmin.nav.reports'), ChartColumn),
          item('/admin/branding', t('schoolAdmin.nav.branding'), Palette),
          item('/admin/features', t('schoolAdmin.nav.features'), ToggleRight),
          item('/admin/settings', t('schoolAdmin.nav.settings'), Settings),
          item('/admin/support-access', t('schoolAdmin.nav.support'), LifeBuoy, badge('supportAccess')),
          item('/admin/usage', t('schoolAdmin.nav.usage'), Gauge),
          ...(owner
            ? [
                item('/admin/domain', t('schoolAdmin.nav.domain'), Globe),
                item('/admin/billing', t('schoolAdmin.nav.billing'), FileText),
                item('/admin/data', t('schoolAdmin.nav.data'), Database),
              ]
            : []),
          item('/admin/audit-log', t('schoolAdmin.nav.audit'), ScrollText),
        ],
        current,
      )}
      {...props}
    />
  );
}

/** Platform console (06 §10.3): fixed console theme and a permanent realm strip. */
export async function ConsoleFrame({ current, ...props }: FrameProps) {
  const t = await getTranslations();
  const me = await getConsoleMe();
  const owner = me?.role === 'PLATFORM_OWNER';
  const manager = owner || me?.role === 'PLATFORM_OPERATOR';
  const item = (href: string, label: string, Icon: typeof Users) => ({
    href,
    label,
    icon: <Icon aria-hidden="true" className={icon} />,
  });
  return (
    <WorkspaceShell
      variant="console"
      realmLabel={t('console.realm')}
      brand={{ name: 'StudyHub', href: '/' }}
      navLabel={t('console.navLabel')}
      skipLabel={t('common.skipToContent')}
      menuLabel={t('common.menu')}
      closeLabel={t('common.close')}
      breadcrumbLabel={t('common.breadcrumb')}
      accountMenu={<ConsoleAccountMenu />}
      nav={markCurrent(
        [
          item('/', t('platformConsole.nav.overview'), LayoutDashboard),
          item('/tenants', t('platformConsole.nav.tenants'), Building2),
          item('/support', t('platformConsole.nav.support'), LifeBuoy),
          ...(manager
            ? [
                item('/plans', t('platformConsole.nav.plans'), ClipboardList),
                item('/domains', t('platformConsole.nav.domains'), Waypoints),
                item('/statements', t('platformConsole.nav.statements'), FileText),
                item('/staff', t('platformConsole.nav.staff'), UserRoundCog),
              ]
            : []),
          ...(owner
            ? [
                item('/settings', t('platformConsole.nav.settings'), Settings),
                item('/audit-log', t('platformConsole.nav.audit'), ScrollText),
              ]
            : []),
        ],
        current,
      )}
      {...props}
    />
  );
}

async function ConsoleAccountMenu() {
  const me = await getConsoleMe();
  if (me === null) return null;
  const t = await getTranslations('common');
  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-label text-ink md:inline">{me.displayName}</span>
      <SignOutButton label={t('signOut')} endpoint="/api/console/auth/sign-out" next="/sign-in" />
    </div>
  );
}
