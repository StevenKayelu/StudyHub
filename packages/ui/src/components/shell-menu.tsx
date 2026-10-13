'use client';

import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';

import { Sheet } from './dialog.js';

/** The compact-screen navigation sheet of the workspace shells: the shells' only client island. */
export function ShellMenu({
  label,
  closeLabel,
  children,
}: {
  label: string;
  closeLabel: string;
  children: ReactNode;
}) {
  return (
    <Sheet
      title={label}
      closeLabel={closeLabel}
      trigger={
        <button
          type="button"
          className="inline-flex size-11 items-center justify-center rounded-md text-ink hover:bg-sunken"
          aria-label={label}
        >
          <Menu aria-hidden="true" className="size-5" strokeWidth={1.5} />
        </button>
      }
    >
      {children}
    </Sheet>
  );
}
