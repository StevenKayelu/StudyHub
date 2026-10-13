import 'server-only';

import type { TenantBootstrap } from '@studyhub/contracts';
import { buttonClasses, PublicShell } from '@studyhub/ui';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { getMe } from '../lib/session';
import { getTerms } from '../lib/tenant';
import { SignOutButton } from './sign-out-button';

const brandOf = (tenant: TenantBootstrap) => ({ name: tenant.branding.displayName, href: '/' });

/** Public pages of a school (06 §1.4): header with brand and navigation, footer with legal links. */
export async function PublicFrame({
  tenant,
  current,
  children,
}: {
  tenant: TenantBootstrap;
  current?: 'browse' | 'teach';
  children: ReactNode;
}) {
  const locale = await getLocale();
  const t = await getTranslations();
  const terms = await getTerms(tenant, locale);
  const me = await getMe();
  return (
    <PublicShell
      brand={brandOf(tenant)}
      navLabel={t('common.mainNavigation')}
      skipLabel={t('common.skipToContent')}
      nav={[
        { href: '/browse', label: t('public.nav.browse'), current: current === 'browse' },
        { href: '/teach', label: t('public.nav.teach', terms), current: current === 'teach' },
      ]}
      actions={
        me === null ? (
          <>
            <NextLink href="/sign-in" className={buttonClasses('ghost', 'sm')}>
              {t('common.signIn')}
            </NextLink>
            <NextLink href="/sign-up" className={buttonClasses('primary', 'sm')}>
              {t('common.createAccount')}
            </NextLink>
          </>
        ) : (
          <>
            <NextLink href="/learn" className={buttonClasses('secondary', 'sm')}>
              {t('learn.title')}
            </NextLink>
            <SignOutButton label={t('common.signOut')} />
          </>
        )
      }
      footer={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <NextLink href="/help">{t('public.footer.help')}</NextLink>
          <NextLink href="/terms">{t('public.footer.terms')}</NextLink>
          <NextLink href="/privacy">{t('public.footer.privacy')}</NextLink>
          <NextLink href="/refunds">{t('public.footer.refunds')}</NextLink>
          {tenant.branding.showPoweredBy ? <span className="ms-auto">{t('common.poweredBy')}</span> : null}
        </div>
      }
    >
      {children}
    </PublicShell>
  );
}
