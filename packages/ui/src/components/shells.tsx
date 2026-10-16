// Server-safe shells. The workspace shells live in workspace-shell.tsx, so public and learner pages
// never load the compact-screen menu (a client island with Radix Dialog).
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { cx } from './cx.js';
import { Link } from './link.js';

export interface ShellNavItem {
  href: string;
  label: string;
  icon?: ReactNode;
  current?: boolean;
  /** A short count next to the label (waiting queue items); `badgeTone: 'warning'` marks overdue ones. */
  badge?: string;
  badgeTone?: 'neutral' | 'warning';
}

export interface Brand {
  name: string;
  href: string;
  /** Logo image URL; without it the name is shown as text. */
  logoSrc?: string;
}

/** "Skip to content" (06 §2.8). Visible only when focused. */
export function SkipLink({ href = '#content', label }: { href?: string; label: string }) {
  return (
    <a
      href={href}
      className={cx(
        'sr-only z-[60] rounded-md bg-surface px-4 py-2 text-label text-ink shadow-1',
        'focus:not-sr-only focus:fixed focus:top-2 focus:left-2',
      )}
    >
      {label}
    </a>
  );
}

export function BrandMark({ brand }: { brand: Brand }) {
  return (
    <Link href={brand.href} className="inline-flex min-h-11 items-center gap-2 text-h3 text-ink no-underline">
      {/* A plain <img>: this package is framework-free; logos are small SVG or PNG files. */}
      {brand.logoSrc !== undefined ? (
        <img src={brand.logoSrc} alt={brand.name} className="h-8 w-auto" />
      ) : (
        <span>{brand.name}</span>
      )}
    </Link>
  );
}

export const currentLine = 'after:absolute after:bg-accent after:rounded-full';

function TopNav({ label, items }: { label: string; items: ShellNavItem[] }) {
  return (
    <nav aria-label={label} className="hidden md:block">
      <ul className="flex items-center gap-1">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.current === true ? 'page' : undefined}
              className={cx(
                'relative inline-flex min-h-11 items-center px-3 text-label text-muted no-underline hover:text-ink',
                item.current === true &&
                  cx('text-ink', currentLine, 'after:inset-x-3 after:bottom-0 after:h-[3px]'),
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface BaseShellProps {
  brand: Brand;
  nav: ShellNavItem[];
  /** Accessible name of the main navigation, e.g. "Main". */
  navLabel: string;
  skipLabel: string;
  /** Page-level banners (offline, support session, maintenance) above the header. */
  banner?: ReactNode;
  children: ReactNode;
}

export interface PublicShellProps extends BaseShellProps {
  actions?: ReactNode;
  footer: ReactNode;
}

/** Public pages: catalogue, course and tutor pages, help, sign-in (06 §1.4). */
export function PublicShell({
  brand,
  nav,
  navLabel,
  skipLabel,
  banner,
  actions,
  footer,
  children,
}: PublicShellProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink label={skipLabel} />
      {banner}
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-app items-center gap-4 px-4 md:px-6 lg:px-8">
          <BrandMark brand={brand} />
          <TopNav label={navLabel} items={nav} />
          <div className="ms-auto flex items-center gap-2">{actions}</div>
        </div>
      </header>
      <main id="content" tabIndex={-1} className="mx-auto w-full max-w-app flex-1 px-4 py-6 md:px-6 lg:px-8">
        {children}
      </main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto max-w-app px-4 py-6 text-body-sm text-muted md:px-6 lg:px-8">{footer}</div>
      </footer>
    </div>
  );
}

export interface LearnShellProps extends BaseShellProps {
  search?: ReactNode;
  actions?: ReactNode;
  /** Hide the bottom bar (course player and Focus mode, 06 §1.5). */
  immersive?: boolean;
}

/**
 * Learner space: top bar from 600 px; on compact screens a bottom bar with the four labelled
 * destinations (Home · Browse · Learning · Account).
 */
export function LearnShell({
  brand,
  nav,
  navLabel,
  skipLabel,
  banner,
  search,
  actions,
  immersive = false,
  children,
}: LearnShellProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink label={skipLabel} />
      {banner}
      <header className="sticky top-0 z-[10] border-b border-line bg-surface">
        <div className="mx-auto flex max-w-app items-center gap-4 px-4 md:px-6 lg:px-8">
          <BrandMark brand={brand} />
          <TopNav label={navLabel} items={nav} />
          <div className="ms-auto flex items-center gap-2">
            {search}
            {actions}
          </div>
        </div>
      </header>
      <main
        id="content"
        tabIndex={-1}
        className={cx(
          'mx-auto w-full max-w-app flex-1 px-4 py-6 md:px-6 lg:px-8',
          !immersive && 'pb-24 md:pb-6',
        )}
      >
        {children}
      </main>
      {immersive ? null : (
        <nav
          aria-label={navLabel}
          className="fixed inset-x-0 bottom-0 z-[10] border-t border-line bg-surface md:hidden"
        >
          <ul className="grid grid-cols-4">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={item.current === true ? 'page' : undefined}
                  className={cx(
                    'relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-caption no-underline',
                    item.current === true
                      ? cx('text-ink', currentLine, 'after:inset-x-6 after:top-0 after:h-[3px]')
                      : 'text-muted',
                  )}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

export interface Breadcrumb {
  href: string;
  label: string;
}

export function Breadcrumbs({ label, items }: { label: string; items: Breadcrumb[] }) {
  return (
    <nav aria-label={label}>
      <ol className="flex flex-wrap items-center gap-1 text-body-sm text-muted">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={item.href} className="flex items-center gap-1">
              {last ? (
                <span aria-current="page" className="text-ink">
                  {item.label}
                </span>
              ) : (
                <>
                  <Link href={item.href} className="inline-flex min-h-6 items-center text-muted">
                    {item.label}
                  </Link>
                  <ChevronRight aria-hidden="true" className="size-4" strokeWidth={1.5} />
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
