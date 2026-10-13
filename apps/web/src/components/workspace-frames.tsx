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
  Users,
} from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { getTerms } from '../lib/tenant';

const icon = 'size-5 shrink-0';

const brandOf = (tenant: TenantBootstrap) => ({ name: tenant.branding.displayName, href: '/' });

type FrameProps = Pick<WorkspaceShellProps, 'title' | 'headerActions' | 'breadcrumbs' | 'children'>;

/** Studio, the tutor workspace (06 §1.4). */
export async function StudioFrame({ tenant, ...props }: FrameProps & { tenant: TenantBootstrap }) {
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
      nav={[
        {
          href: '/studio',
          label: t('studio.nav.courses', terms),
          icon: <Library aria-hidden="true" className={icon} />,
          current: true,
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
      ]}
      {...props}
    />
  );
}

/** Tenant administration (06 §1.4, §10.2). */
export async function AdminFrame({ tenant, ...props }: FrameProps & { tenant: TenantBootstrap }) {
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
      nav={[
        {
          href: '/admin',
          label: t('admin.nav.overview'),
          icon: <LayoutDashboard aria-hidden="true" className={icon} />,
          current: true,
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
      ]}
      {...props}
    />
  );
}

/** Platform console (06 §10.3): fixed console theme and a permanent realm strip. */
export async function ConsoleFrame(props: FrameProps) {
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
      nav={[
        {
          href: '/',
          label: t('console.nav.overview'),
          icon: <LayoutDashboard aria-hidden="true" className={icon} />,
          current: true,
        },
        {
          href: '/tenants',
          label: t('console.nav.tenants'),
          icon: <Building2 aria-hidden="true" className={icon} />,
        },
        {
          href: '/settings',
          label: t('console.nav.settings'),
          icon: <Settings aria-hidden="true" className={icon} />,
        },
      ]}
      {...props}
    />
  );
}
