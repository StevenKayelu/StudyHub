'use client';

import { X } from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import type { ReactNode } from 'react';

import { cx } from './cx.js';

interface OverlayDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element that opens the dialog (rendered as-is through Radix `asChild`). */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Accessible label of the close button, e.g. "Close". */
  closeLabel: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** While destructive work is in progress, Esc and outside clicks don't close it (06 §2.5). */
  preventClose?: boolean;
}

function Frame({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  closeLabel,
  children,
  footer,
  preventClose = false,
  contentClassName,
}: OverlayDialogProps & { contentClassName: string }) {
  const block = (event: Event) => {
    if (preventClose) event.preventDefault();
  };
  return (
    <RadixDialog.Root
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange !== undefined ? { onOpenChange } : {})}
    >
      {trigger !== undefined ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[50] bg-black/40" />
        <RadixDialog.Content
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
          className={cx('fixed z-[50] flex flex-col bg-surface text-ink shadow-2', contentClassName)}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line p-4">
            <div>
              <RadixDialog.Title className="text-h3">{title}</RadixDialog.Title>
              {description !== undefined ? (
                <RadixDialog.Description className="mt-1 text-body-sm text-muted">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close
              aria-label={closeLabel}
              disabled={preventClose}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken"
            >
              <X aria-hidden="true" className="size-5" strokeWidth={1.5} />
            </RadixDialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-4">{children}</div>
          {footer !== undefined ? (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line p-4">{footer}</div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Confirmations and short forms only; focus is trapped (06 §2.5). */
export function Dialog(props: OverlayDialogProps) {
  return (
    <Frame
      {...props}
      contentClassName="left-1/2 top-1/2 max-h-[85dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg"
    />
  );
}

/** Bottom sheet on compact screens, side sheet from 1024 px (06 §2.5, §7). */
export function Sheet(props: OverlayDialogProps) {
  return (
    <Frame
      {...props}
      contentClassName={cx(
        'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-lg',
        'lg:inset-y-0 lg:right-0 lg:left-auto lg:max-h-none lg:w-[360px] lg:rounded-none lg:rounded-l-lg',
      )}
    />
  );
}
