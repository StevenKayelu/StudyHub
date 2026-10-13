import 'server-only';

import type { TenantBootstrap } from '@studyhub/contracts';
import { buttonClasses, StatePanel } from '@studyhub/ui';
import NextLink from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { PublicFrame } from './public-frame';

/** Narrow, centred auth screens (S-A01 to S-A06) inside the school's public shell. */
export function AuthPage({
  tenant,
  title,
  intro,
  children,
  footer,
}: {
  tenant: TenantBootstrap;
  title?: ReactNode;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <PublicFrame tenant={tenant}>
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 py-6">
        {title !== undefined ? (
          <div className="flex flex-col gap-2">
            <h1 className="text-h1">{title}</h1>
            {intro !== undefined ? <p className="text-body text-muted">{intro}</p> : null}
          </div>
        ) : null}
        {children}
        {footer !== undefined ? <div className="text-body-sm text-muted">{footer}</div> : null}
      </div>
    </PublicFrame>
  );
}

/** S-X05 Permission denied: who you are signed in as, and a way out (06 §2.6). */
export async function PermissionDenied({ name }: { name: string }) {
  const t = await getTranslations('system.permission');
  const common = await getTranslations('common');
  return (
    <main id="content">
      <StatePanel
        kind="permission"
        headingLevel={1}
        title={t('title')}
        message={`${t('message')} ${t('signedInAs', { name })}`}
        actions={
          <NextLink href="/learn" className={buttonClasses('secondary')}>
            {common('goHome')}
          </NextLink>
        }
      />
    </main>
  );
}
