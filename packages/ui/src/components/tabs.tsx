'use client';

import { Tabs as RadixTabs } from 'radix-ui';
import type { ReactNode } from 'react';

import { cx } from './cx.js';
import { Link } from './link.js';

/** The accent "line" marks the current item (06 §1.3 signature motif). */
const itemClasses = cx(
  'relative inline-flex min-h-11 items-center px-3 text-label text-muted no-underline hover:text-ink',
  'after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-full after:bg-transparent',
);
const currentClasses = 'text-ink after:bg-accent';

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
}

export interface TabsProps {
  /** Accessible name of the tab list. */
  label: string;
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export function Tabs({ label, items, ...rest }: TabsProps) {
  return (
    <RadixTabs.Root {...rest} defaultValue={rest.defaultValue ?? items[0]?.value}>
      <RadixTabs.List aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            className={cx(itemClasses, 'data-[state=active]:text-ink data-[state=active]:after:bg-accent')}
          >
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value} className="pt-4">
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

export interface NavItem {
  href: string;
  label: ReactNode;
  current?: boolean;
}

/** Horizontal secondary navigation between pages (e.g. a course workspace's sections). */
export function SecondaryNav({ label, items }: { label: string; items: NavItem[] }) {
  return (
    <nav aria-label={label} className="border-b border-line">
      <ul className="flex gap-1 overflow-x-auto">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.current === true ? 'page' : undefined}
              className={cx(itemClasses, item.current === true && currentClasses)}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
