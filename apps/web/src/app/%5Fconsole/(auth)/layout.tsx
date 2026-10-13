import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/** Console sign-in steps: the realm strip and a narrow card, no navigation. */
export default async function ConsoleAuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('console');
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="bg-accent px-4 py-1.5 text-center text-label text-on-accent">{t('realm')}</div>
      <main id="content" className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-10">
        {children}
      </main>
    </div>
  );
}
