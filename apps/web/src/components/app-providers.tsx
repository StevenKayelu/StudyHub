'use client';

import { type LinkComponent, LinkProvider } from '@studyhub/ui';
import NextLink from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

// Anchor props are a subset of next/link's; the cast only bridges exactOptionalPropertyTypes.
const RouterLink: LinkComponent = ({ href, ...props }) => (
  <NextLink href={href} {...(props as Omit<ComponentProps<typeof NextLink>, 'href'>)} />
);

/** Client-side providers: design-system links use the Next.js router. */
export function AppProviders({ children }: { children: ReactNode }) {
  return <LinkProvider component={RouterLink}>{children}</LinkProvider>;
}
