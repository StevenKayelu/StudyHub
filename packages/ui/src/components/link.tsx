'use client';

import {
  type AnchorHTMLAttributes,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
} from 'react';

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  children?: ReactNode;
}

export type LinkComponent = (props: LinkProps) => ReactElement;

const PlainLink: LinkComponent = (props) => <a {...props} />;

const LinkContext = createContext<LinkComponent>(PlainLink);

/**
 * Lets the app supply its router link (e.g. next/link) to every component that renders navigation,
 * so this package stays framework-free. Defaults to a plain <a>.
 */
export function LinkProvider({ component, children }: { component: LinkComponent; children: ReactNode }) {
  return <LinkContext.Provider value={component}>{children}</LinkContext.Provider>;
}

export function Link(props: LinkProps) {
  const Component = useContext(LinkContext);
  return <Component {...props} />;
}
