import './globals.css';

import type { Metadata, Viewport } from 'next';
import { getLocale } from 'next-intl/server';
import type { ReactNode } from 'react';

import { AppProviders } from '../components/app-providers';
import { fontVariables } from '../fonts';

export const metadata: Metadata = {
  title: 'StudyHub',
  description: 'StudyHub learning platform',
  // Nothing is public yet; school pages opt in to indexing with the catalogue (M5).
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f5f0' },
    { media: '(prefers-color-scheme: dark)', color: '#111416' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={fontVariables}>
      <body>
        {/* Translations happen on the server; client components receive translated strings as props. */}
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
