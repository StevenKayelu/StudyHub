import 'server-only';

import type { TenantBootstrap } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { getMe, requestedPath } from '../lib/session';
import { currentTenant } from '../lib/tenant';

/** BR-52/BR-53: a suspended or offboarding school is read-only. */
export function isReadOnlySchool(tenant: TenantBootstrap): boolean {
  return tenant.status === 'SUSPENDED' || tenant.status === 'OFFBOARDING';
}

/**
 * S-X07 (suspended or offboarding, BR-52) and S-X08 (provisioning): neutral pages with the school's name.
 * Links are plain anchors: a full page load re-evaluates every layout's gate (soft navigation would
 * keep the layout that rendered this page).
 */
export async function SchoolStatusPage({ tenant }: { tenant: TenantBootstrap }) {
  const t = await getTranslations('system');
  const name = tenant.branding.displayName;
  const provisioning = tenant.status === 'PROVISIONING';
  const signedIn = provisioning ? false : (await getMe()) !== null;
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
            <a href="/sign-in" className={buttonClasses('secondary')}>
              {t('comingSoon.ownerSignIn')}
            </a>
          }
        />
      ) : (
        <StatePanel
          kind="unavailable"
          headingLevel={1}
          title={t('unavailable.title')}
          message={t('unavailable.message')}
          actions={
            <a
              href={signedIn ? '/learn' : '/sign-in?returnTo=%2Flearn'}
              className={buttonClasses('secondary')}
            >
              {signedIn ? t('unavailable.myLearning') : t('unavailable.learnerSignIn')}
            </a>
          }
        />
      )}
    </main>
  );
}

/**
 * Shows S-X07 instead of `children` while the school is read-only, unless the requested path is
 * allowed. Used by the school layout (first load) and by each space's layout, which Next.js renders
 * again when a client-side navigation enters that space.
 */
export async function ReadOnlyGate({ children, allow }: { children: ReactNode; allow?: RegExp }) {
  const tenant = await currentTenant();
  if (tenant !== null && isReadOnlySchool(tenant) && !(allow?.test(await requestedPath()) ?? false)) {
    return <SchoolStatusPage tenant={tenant} />;
  }
  return children;
}
