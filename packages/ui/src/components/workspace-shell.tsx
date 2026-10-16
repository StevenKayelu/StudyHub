import type { ReactNode } from 'react';

import { cx } from './cx.js';
import { Link } from './link.js';
import { ShellMenu } from './shell-menu.js';
import {
  type BaseShellProps,
  BrandMark,
  type Breadcrumb,
  Breadcrumbs,
  currentLine,
  type ShellNavItem,
  SkipLink,
} from './shells.js';

export type WorkspaceVariant = 'studio' | 'admin' | 'console';

export interface WorkspaceShellProps extends BaseShellProps {
  variant: WorkspaceVariant;
  /** Permanent realm strip, e.g. "Platform console" (06 §10.3). Required for the console. */
  realmLabel?: string;
  title: ReactNode;
  breadcrumbs?: Breadcrumb[];
  breadcrumbLabel: string;
  headerActions?: ReactNode;
  /** Label of the compact-screen menu button and its sheet, e.g. "Menu". */
  menuLabel: string;
  closeLabel: string;
  accountMenu?: ReactNode;
}

function RailLinks({ items, compactRail }: { items: ShellNavItem[]; compactRail: boolean }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            aria-current={item.current === true ? 'page' : undefined}
            className={cx(
              'relative flex min-h-11 items-center gap-3 rounded-md px-3 text-label no-underline',
              compactRail &&
                'md:max-lg:flex-col md:max-lg:justify-center md:max-lg:gap-0.5 md:max-lg:px-1 md:max-lg:py-2 md:max-lg:text-caption',
              item.current === true
                ? cx('bg-accent-soft text-ink', currentLine, 'after:inset-y-2 after:left-0 after:w-[3px]')
                : 'text-muted hover:bg-sunken hover:text-ink',
            )}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badge !== undefined ? (
              <span
                className={cx(
                  'ml-auto rounded-full px-2 text-caption tabular',
                  compactRail && 'md:max-lg:ml-0',
                  item.badgeTone === 'warning' ? 'bg-warning-soft text-ink' : 'bg-sunken text-ink',
                )}
              >
                {item.badge}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Studio (tutor), tenant admin and platform console: a left rail with icons and labels (collapsed to
 * icons over short labels between 600 and 1023 px), a page header with breadcrumbs, and a menu sheet
 * on compact screens (06 §1.5).
 */
export function WorkspaceShell({
  variant,
  realmLabel,
  brand,
  nav,
  navLabel,
  skipLabel,
  banner,
  title,
  breadcrumbs,
  breadcrumbLabel,
  headerActions,
  menuLabel,
  closeLabel,
  accountMenu,
  children,
}: WorkspaceShellProps) {
  return (
    <div className="flex min-h-dvh flex-col" data-workspace={variant}>
      <SkipLink label={skipLabel} />
      {realmLabel !== undefined ? (
        <div className="bg-accent px-4 py-1.5 text-center text-label text-on-accent">{realmLabel}</div>
      ) : null}
      {banner}
      <header className="sticky top-0 z-[10] flex items-center gap-3 border-b border-line bg-surface px-4 md:px-6">
        <div className="md:hidden">
          <ShellMenu label={menuLabel} closeLabel={closeLabel}>
            <nav aria-label={navLabel}>
              <RailLinks items={nav} compactRail={false} />
            </nav>
          </ShellMenu>
        </div>
        <BrandMark brand={brand} />
        <div className="ms-auto flex items-center gap-2">{accountMenu}</div>
      </header>
      <div className="flex flex-1">
        <nav
          aria-label={navLabel}
          className="sticky top-14 hidden max-h-[calc(100dvh-3.5rem)] shrink-0 overflow-y-auto border-r border-line bg-surface p-2 md:block md:w-24 lg:w-60"
        >
          <RailLinks items={nav} compactRail />
        </nav>
        <main id="content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 md:px-6 lg:px-8">
          <div className="mx-auto flex max-w-app flex-col gap-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="flex flex-col gap-1">
                {breadcrumbs !== undefined && breadcrumbs.length > 0 ? (
                  <Breadcrumbs label={breadcrumbLabel} items={breadcrumbs} />
                ) : null}
                <h1 className="text-h1">{title}</h1>
              </div>
              {headerActions !== undefined ? <div className="flex gap-2">{headerActions}</div> : null}
            </div>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
