import { consoleThemeCss } from '@studyhub/ui/theme';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: { default: 'Platform console', template: '%s · Platform console' },
};

/**
 * The platform console realm (console.<platform-domain>, 06 §10.3): a fixed info-blue theme, never
 * copper or a school's branding. Sign-in with TOTP and staff permissions arrive in M4.
 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style href="theme-console" precedence="default">
        {consoleThemeCss()}
      </style>
      {children}
    </>
  );
}
