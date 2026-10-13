import 'server-only';

import type { TenantBootstrap } from '@studyhub/contracts';
import { LearnShell, type ShellNavItem } from '@studyhub/ui';
import { BookOpen, Compass, House, UserRound } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

const icon = 'size-5 shrink-0';

const brandOf = (tenant: TenantBootstrap) => ({ name: tenant.branding.displayName, href: '/' });

export type LearnSection = 'home' | 'browse' | 'learning' | 'account';

/** Learner space (06 §1.5): bottom bar on compact screens, top bar from 600 px. */
export async function LearnFrame({
  tenant,
  current,
  children,
}: {
  tenant: TenantBootstrap;
  current: LearnSection;
  children: ReactNode;
}) {
  const t = await getTranslations();
  const nav: (ShellNavItem & { key: LearnSection })[] = [
    {
      key: 'home',
      href: '/learn',
      label: t('learn.nav.home'),
      icon: <House aria-hidden="true" className={icon} />,
    },
    {
      key: 'browse',
      href: '/browse',
      label: t('learn.nav.browse'),
      icon: <Compass aria-hidden="true" className={icon} />,
    },
    {
      key: 'learning',
      href: '/learn/courses',
      label: t('learn.nav.learning'),
      icon: <BookOpen aria-hidden="true" className={icon} />,
    },
    {
      key: 'account',
      href: '/account',
      label: t('learn.nav.account'),
      icon: <UserRound aria-hidden="true" className={icon} />,
    },
  ];
  return (
    <LearnShell
      brand={brandOf(tenant)}
      navLabel={t('common.mainNavigation')}
      skipLabel={t('common.skipToContent')}
      nav={nav.map(({ key, ...item }) => ({ ...item, current: key === current }))}
    >
      {children}
    </LearnShell>
  );
}
