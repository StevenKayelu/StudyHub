'use client';

import { buttonClasses, StatePanel } from '@studyhub/ui';

import { useErrorTexts } from '../../../components/error-texts';

/** S-X02 Error: a page failed to render. The digest lets support find the server log entry. */
export default function SchoolError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useErrorTexts();
  return (
    <main id="content">
      <StatePanel
        kind="error"
        headingLevel={1}
        title={t.title}
        message={t.message}
        actions={
          <>
            <button type="button" className={buttonClasses('primary')} onClick={reset}>
              {t.tryAgain}
            </button>
            {/* A full page load: the router state may be what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className={buttonClasses('secondary')}>
              {t.goHome}
            </a>
          </>
        }
        {...(error.digest !== undefined
          ? { details: { summary: t.details, content: t.requestId.replace('{id}', error.digest) } }
          : {})}
      />
    </main>
  );
}
