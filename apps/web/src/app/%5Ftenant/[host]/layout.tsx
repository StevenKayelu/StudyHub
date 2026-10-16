import type { TenantBootstrap } from '@studyhub/contracts';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { ErrorTextsProvider } from '../../../components/error-texts';
import { isReadOnlySchool, SchoolStatusPage } from '../../../components/school-status';
import { requestedPath } from '../../../lib/session';
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
  // Absolute URLs for sharing previews: this school's own host (validated by src/proxy.ts).
  const host = (await headers()).get('host') ?? 'localhost';
  const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  return {
    metadataBase: new URL(`${scheme}://${host}`),
    title: { default: name, template: `%s · ${name}` },
    applicationName: name,
    manifest: '/manifest.webmanifest',
    icons: { icon: [{ url: '/mark.svg', type: 'image/svg+xml' }], apple: [{ url: '/icon/192' }] },
    openGraph: { siteName: name, title: name, images: [{ url: '/og.png', width: 1200, height: 630 }] },
  };
}

/** Paths a read-only school still serves (BR-52): sign-in and the learner space. */
const READ_ONLY_PATHS = /^\/(sign-in|switch|learn|legal|admin\/data)(\/|\?|$)/;

/**
 * Paths a school being set up serves (F37): visitors get "coming soon", while the owner accepts the
 * invitation, signs in and prepares the school (S-AD11). Each space still checks who may enter.
 */
const PROVISIONING_PATHS =
  /^\/(sign-in|switch|invitations|forgot-password|reset-password|verify-email|admin|studio|account|support|legal)(\/|\?|$)/;

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
        {tenant.status === 'ACTIVE' ||
        (isReadOnlySchool(tenant) && READ_ONLY_PATHS.test(await requestedPath())) ||
        (tenant.status === 'PROVISIONING' && PROVISIONING_PATHS.test(await requestedPath())) ? (
          children
        ) : (
          <SchoolStatusPage tenant={tenant} />
        )}
      </ErrorTextsProvider>
    </>
  );
}
