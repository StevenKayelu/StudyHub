'use client';

import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  CloudOff,
  FileText,
  Info,
  LoaderCircle,
  type LucideIcon,
  Send,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { cx } from './cx.js';

export type Tone = 'info' | 'success' | 'warning' | 'danger';

const toneClasses: Record<Tone, { box: string; icon: string; Icon: LucideIcon }> = {
  info: { box: 'border-info bg-info-soft', icon: 'text-info', Icon: Info },
  success: { box: 'border-success bg-success-soft', icon: 'text-success', Icon: CircleCheck },
  warning: { box: 'border-warning bg-warning-soft', icon: 'text-warning', Icon: TriangleAlert },
  danger: { box: 'border-danger bg-danger-soft', icon: 'text-danger', Icon: CircleAlert },
};

export interface AlertProps {
  tone: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** "alert" interrupts screen readers: use it only for errors that need attention now. */
  role?: 'alert' | 'status';
}

/** Inline, form-level or section-level message. Colour is never the only signal: icon + text. */
export function Alert({ tone, title, children, action, role }: AlertProps) {
  const { box, icon, Icon } = toneClasses[tone];
  return (
    <div role={role} className={cx('flex gap-3 rounded-md border p-4 text-ink', box)}>
      <Icon aria-hidden="true" className={cx('mt-0.5 size-5 shrink-0', icon)} strokeWidth={1.5} />
      <div className="flex flex-1 flex-col gap-1">
        {title !== undefined ? <p className="text-label">{title}</p> : null}
        {children !== undefined ? <div className="text-body-sm">{children}</div> : null}
        {action !== undefined ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

/** Full-width page-level strip (offline, maintenance, support session). */
export function Banner({ tone, children, action }: { tone: Tone; children: ReactNode; action?: ReactNode }) {
  const { box, icon, Icon } = toneClasses[tone];
  return (
    <div role="status" className={cx('border-b px-4 py-2 text-ink', box)}>
      <div className="mx-auto flex max-w-app flex-wrap items-center gap-x-3 gap-y-1 text-body-sm">
        <Icon aria-hidden="true" className={cx('size-4 shrink-0', icon)} strokeWidth={1.5} />
        <span className="flex-1">{children}</span>
        {action}
      </div>
    </div>
  );
}

export type BadgeStatus = 'draft' | 'review' | 'published' | 'pending' | 'paid' | 'failed' | 'attention';

const badgeStyles: Record<BadgeStatus, { classes: string; Icon: LucideIcon }> = {
  draft: { classes: 'bg-sunken text-muted', Icon: FileText },
  review: { classes: 'bg-info-soft text-info', Icon: Send },
  published: { classes: 'bg-success-soft text-success', Icon: CircleCheck },
  pending: { classes: 'bg-warning-soft text-warning', Icon: Clock },
  paid: { classes: 'bg-success-soft text-success', Icon: CircleCheck },
  failed: { classes: 'bg-danger-soft text-danger', Icon: CircleX },
  attention: { classes: 'bg-warning-soft text-warning', Icon: TriangleAlert },
};

/** Status with icon + text; the label comes from the app's message catalog. */
export function StatusBadge({ status, children }: { status: BadgeStatus; children: ReactNode }) {
  const { classes, Icon } = badgeStyles[status];
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-caption', classes)}>
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={2} />
      {children}
    </span>
  );
}

export type SaveState = 'saving' | 'saved' | 'offline' | 'error';

export interface SaveIndicatorProps {
  state: SaveState;
  /** Localised text for the current state, e.g. "Saved · 2 s ago". */
  label: string;
  /** Shown with the error state ("Retry"). */
  onRetry?: () => void;
  retryLabel?: string;
}

const saveIcons: Record<SaveState, { Icon: LucideIcon; classes: string }> = {
  saving: { Icon: LoaderCircle, classes: 'text-muted animate-spin' },
  saved: { Icon: CircleCheck, classes: 'text-success' },
  offline: { Icon: CloudOff, classes: 'text-warning' },
  error: { Icon: CircleAlert, classes: 'text-danger' },
};

/** "Saving…" / "Saved" / "Offline — will sync" / "Couldn't save · Retry" (06 §2.5). */
export function SaveIndicator({ state, label, onRetry, retryLabel }: SaveIndicatorProps) {
  const { Icon, classes } = saveIcons[state];
  return (
    <span role="status" className="inline-flex items-center gap-1.5 text-caption text-muted">
      <Icon aria-hidden="true" className={cx('size-4', classes)} strokeWidth={1.5} />
      <span>{label}</span>
      {state === 'error' && onRetry !== undefined ? (
        <button type="button" onClick={onRetry} className="min-h-6 text-accent underline">
          {retryLabel}
        </button>
      ) : null}
    </span>
  );
}

/** Placeholder block, shown only after 300 ms so fast loads never flash (06 §2.6). */
export function Skeleton({ className, delayMs = 300 }: { className?: string; delayMs?: number }) {
  const [visible, setVisible] = useState(delayMs === 0);
  useEffect(() => {
    if (delayMs === 0) return undefined;
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return (
    <div
      aria-hidden="true"
      className={cx('rounded-md bg-sunken', visible ? 'animate-pulse' : 'invisible', className)}
    />
  );
}
