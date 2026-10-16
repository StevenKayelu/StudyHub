import 'server-only';

import type { TenantBootstrap } from '@studyhub/contracts';
import { localizedText } from '@studyhub/contracts';
import { Banner, buttonClasses, PublicShell } from '@studyhub/ui';
import NextLink from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { getMe } from '../lib/session';
import { getTerms } from '../lib/tenant';
import { SignOutButton } from './sign-out-button';

const brandOf = (tenant: TenantBootstrap) => ({
  name: tenant.branding.displayName,
  href: '/',
  ...(tenant.branding.logoAssetId !== null && {
    logoSrc: `/api/v1/tenant/brand/${tenant.branding.logoAssetId}`,
  }),
});

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
      {...(tenant.notice !== null && { banner: <Banner tone="info">{tenant.notice}</Banner> })}
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
          {tenant.legal.terms ? <NextLink href="/legal/terms">{t('public.footer.terms')}</NextLink> : null}
          {tenant.legal.privacy ? (
            <NextLink href="/legal/privacy">{t('public.footer.privacy')}</NextLink>
          ) : null}
          {tenant.legal.refunds ? (
            <NextLink href="/legal/refunds">{t('public.footer.refunds')}</NextLink>
          ) : null}
          {tenant.branding.footerLinks.map((link) => (
            <a
              key={link.url}
              href={link.url}
              {...(link.url.startsWith('https://') && { rel: 'noopener noreferrer' })}
            >
              {localizedText(link.label, locale, tenant.locales.defaultLocale) ?? link.url}
            </a>
          ))}
          {tenant.branding.supportEmail !== null ? (
            <a href={`mailto:${tenant.branding.supportEmail}`}>{tenant.branding.supportEmail}</a>
          ) : null}
          {tenant.branding.supportPhone !== null ? (
            <a href={`tel:${tenant.branding.supportPhone.replace(/[^+\d]/g, '')}`}>
              {tenant.branding.supportPhone}
            </a>
          ) : null}
          {Object.entries(tenant.branding.social).map(([network, url]) => (
            <a key={network} href={url} rel="noopener noreferrer" className="capitalize">
              {network}
            </a>
          ))}
          {tenant.branding.showPoweredBy ? <span className="ms-auto">{t('common.poweredBy')}</span> : null}
        </div>
      }
    >
      {children}
    </PublicShell>
  );
}
