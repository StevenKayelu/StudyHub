import 'server-only';

import type { TenantBootstrap } from '@studyhub/contracts';
import { WorkspaceShell, type WorkspaceShellProps } from '@studyhub/ui';
import {
  Building2,
  ChartColumn,
  CreditCard,
  LayoutDashboard,
  Library,
  Palette,
  Settings,
  UserRound,
  UserRoundCog,
  Users,
} from 'lucide-react';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { getConsoleMe, getMe } from '../lib/session';
import { getTerms } from '../lib/tenant';
import { SignOutButton } from './sign-out-button';

const icon = 'size-5 shrink-0';

const brandOf = (tenant: TenantBootstrap) => ({ name: tenant.branding.displayName, href: '/' });

type FrameProps = Pick<WorkspaceShellProps, 'title' | 'headerActions' | 'breadcrumbs' | 'children'> & {
  /** Which navigation item is current (defaults to the first). */
  current?: string;
};

/** Name, account link and sign-out for the signed-in school member. */
async function SchoolAccountMenu() {
  const me = await getMe();
  if (me === null) return null;
  const t = await getTranslations('common');
  return (
    <div className="flex items-center gap-2">
      <NextLink href="/account" className="hidden text-label text-ink no-underline md:inline">
        {me.user.displayName}
      </NextLink>
      <SignOutButton label={t('signOut')} />
    </div>
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

/** Tenant administration (06 §1.4, §10.2). */
export async function AdminFrame({ tenant, current, ...props }: FrameProps & { tenant: TenantBootstrap }) {
  const t = await getTranslations();
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
      nav={markCurrent(
        [
          {
            href: '/admin',
            label: t('admin.nav.overview'),
            icon: <LayoutDashboard aria-hidden="true" className={icon} />,
          },
          {
            href: '/admin/users',
            label: t('admin.nav.users'),
            icon: <Users aria-hidden="true" className={icon} />,
          },
          {
            href: '/admin/branding',
            label: t('admin.nav.branding'),
            icon: <Palette aria-hidden="true" className={icon} />,
          },
          {
            href: '/admin/settings',
            label: t('admin.nav.settings'),
            icon: <Settings aria-hidden="true" className={icon} />,
          },
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
          {
            href: '/',
            label: t('console.nav.overview'),
            icon: <LayoutDashboard aria-hidden="true" className={icon} />,
          },
          {
            href: '/tenants',
            label: t('console.nav.tenants'),
            icon: <Building2 aria-hidden="true" className={icon} />,
          },
          {
            href: '/staff',
            label: t('console.nav.staff'),
            icon: <UserRoundCog aria-hidden="true" className={icon} />,
          },
          {
            href: '/settings',
            label: t('console.nav.settings'),
            icon: <Settings aria-hidden="true" className={icon} />,
          },
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
