import type { TenantBootstrap } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { ErrorTextsProvider } from '../../../components/error-texts';
import { tenantForRoute, tenantThemeCss } from '../../../lib/tenant';

// School pages render per request for now; per-host ISR caching (keyed by /_tenant/<host>) comes with
// the public catalogue (M5).
export const dynamic = 'force-dynamic';

interface TenantLayoutProps {
  children: ReactNode;
  params: Promise<{ host: string }>;
}

/** The school for this route (host-checked, see tenantForRoute), or the site-not-found page (S-X06). */
async function tenantFor(params: TenantLayoutProps['params']): Promise<TenantBootstrap> {
  const tenant = await tenantForRoute((await params).host);
  if (tenant === null) notFound();
  return tenant;
}

export async function generateMetadata({ params }: Pick<TenantLayoutProps, 'params'>): Promise<Metadata> {
  const tenant = await tenantFor(params);
  const name = tenant.branding.displayName;
  return {
    title: { default: name, template: `%s · ${name}` },
    applicationName: name,
    manifest: '/manifest.webmanifest',
    icons: { icon: [{ url: '/mark.svg', type: 'image/svg+xml' }], apple: [{ url: '/icon/192' }] },
    openGraph: { siteName: name, title: name, images: [{ url: '/og.png', width: 1200, height: 630 }] },
  };
}

/** S-X07 (suspended or offboarding, BR-52) and S-X08 (provisioning): neutral pages with the school's name. */
async function StatusPage({ tenant }: { tenant: TenantBootstrap }) {
  const t = await getTranslations('system');
  const name = tenant.branding.displayName;
  const provisioning = tenant.status === 'PROVISIONING';
  return (
    <main id="content" className="flex min-h-dvh flex-col items-center justify-center gap-2">
      <p className="text-h3 text-ink">{name}</p>
      {provisioning ? (
        <StatePanel
          kind="coming-soon"
          headingLevel={1}
          title={t('comingSoon.title')}
          message={t('comingSoon.message', { school: name })}
          actions={
            <NextLink href="/sign-in" className={buttonClasses('secondary')}>
              {t('comingSoon.ownerSignIn')}
            </NextLink>
          }
        />
      ) : (
        <StatePanel
          kind="unavailable"
          headingLevel={1}
          title={t('unavailable.title')}
          message={t('unavailable.message')}
        />
      )}
    </main>
  );
}

export default async function TenantLayout({ children, params }: TenantLayoutProps) {
  const tenant = await tenantFor(params);
  const t = await getTranslations();
  const errorTexts = {
    title: t('system.error.title'),
    message: t('system.error.message'),
    tryAgain: t('common.tryAgain'),
    goHome: t('common.goHome'),
    details: t('common.details'),
    requestId: t.raw('common.requestId') as string,
  };
  return (
    <>
      {/*
        The school's theme (accent tokens + font preset), inlined so the first paint is already
        branded. It is a few hundred bytes; the same CSS is served, immutable, at
        /theme/{tenantId}/{version}.css. React hoists this <style> into <head>.
      */}
      <style href={`theme-${tenant.id}-${tenant.branding.version}`} precedence="default">
        {tenantThemeCss(tenant)}
      </style>
      <ErrorTextsProvider texts={errorTexts}>
        {tenant.status === 'ACTIVE' ? children : <StatusPage tenant={tenant} />}
      </ErrorTextsProvider>
    </>
  );
}
