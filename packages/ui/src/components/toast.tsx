'use client';

import { X } from 'lucide-react';
import { Toast as RadixToast } from 'radix-ui';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  /** Optional action such as Undo; extends the duration to 10 s (06 §2.5). */
  action?: { label: string; altText: string; onAction: () => void };
}

interface ToastEntry extends ToastOptions {
  id: number;
}

const ToastContext = createContext<((toast: ToastOptions) => void) | null>(null);

/** Shows a non-blocking confirmation. Never use toasts for errors that need action. */
export function useToast(): (toast: ToastOptions) => void {
  const show = useContext(ToastContext);
  if (show === null) throw new Error('useToast must be used inside <ToastProvider>.');
  return show;
}

export interface ToastProviderProps {
  children: ReactNode;
  /** Accessible label of each toast's close button, e.g. "Dismiss". */
  closeLabel: string;
  /** Region label announced to screen readers, e.g. "Notifications ({hotkey})". */
  regionLabel: string;
}

let nextId = 1;

export function ToastProvider({ children, closeLabel, regionLabel }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const show = useCallback((toast: ToastOptions) => {
    nextId += 1;
    setToasts((current) => [...current, { ...toast, id: nextId }]);
  }, []);
  const remove = useCallback((id: number) => setToasts((current) => current.filter((t) => t.id !== id)), []);
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider swipeDirection="down" label={regionLabel}>
        {children}
        {toasts.map((toast) => (
          <RadixToast.Root
            key={toast.id}
            type="foreground"
            duration={toast.action !== undefined ? 10_000 : 6_000}
            onOpenChange={(open) => {
              if (!open) remove(toast.id);
            }}
            className="flex items-start gap-3 rounded-md border border-line bg-surface p-4 text-ink shadow-1"
          >
            <div className="flex-1">
              <RadixToast.Title className="text-label">{toast.title}</RadixToast.Title>
              {toast.description !== undefined ? (
                <RadixToast.Description className="text-body-sm text-muted">
                  {toast.description}
                </RadixToast.Description>
              ) : null}
            </div>
            {toast.action !== undefined ? (
              <RadixToast.Action
                altText={toast.action.altText}
                onClick={toast.action.onAction}
                className="min-h-11 rounded-md px-3 text-label text-accent hover:bg-sunken"
              >
                {toast.action.label}
              </RadixToast.Action>
            ) : null}
            <RadixToast.Close
              aria-label={closeLabel}
              className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-sunken"
            >
              <X aria-hidden="true" className="size-4" strokeWidth={1.5} />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed inset-x-4 bottom-20 z-[60] flex flex-col gap-2 outline-none md:inset-x-auto md:right-6 md:bottom-6 md:w-96" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}
