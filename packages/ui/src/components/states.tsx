import {
  Ban,
  CircleAlert,
  CloudOff,
  Compass,
  Hourglass,
  Inbox,
  type LucideIcon,
  Lock,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { cx } from './cx.js';

export type StateKind =
  'empty' | 'error' | 'not-found' | 'permission' | 'offline' | 'maintenance' | 'unavailable' | 'coming-soon';

const glyphs: Record<StateKind, LucideIcon> = {
  empty: Inbox,
  error: CircleAlert,
  'not-found': Compass,
  permission: Lock,
  offline: CloudOff,
  maintenance: Wrench,
  unavailable: Ban,
  'coming-soon': Hourglass,
};

export interface StatePanelProps {
  kind: StateKind;
  title: ReactNode;
  /** One sentence: why it's empty, what happened, or how to get access. */
  message?: ReactNode;
  /** Primary and secondary actions (buttons or links). */
  actions?: ReactNode;
  /** Extra content such as a search box (not found). */
  children?: ReactNode;
  /** Support details, e.g. the request id, behind a "Details" disclosure (06 §2.6). */
  details?: { summary: ReactNode; content: ReactNode };
  /** Page-level states use h1; states inside a page region use h2. */
  headingLevel?: 1 | 2;
  className?: string;
}

/**
 * The standard empty, error, not-found, permission, offline and site-status pattern (06 §2.6, UX-12):
 * a single line glyph, one heading, one sentence and an action. No illustrations.
 */
export function StatePanel({
  kind,
  title,
  message,
  actions,
  children,
  details,
  headingLevel = 2,
  className,
}: StatePanelProps) {
  const Glyph = glyphs[kind];
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <section
      className={cx(
        'mx-auto flex max-w-reading flex-col items-center gap-3 px-4 py-12 text-center',
        className,
      )}
    >
      <Glyph aria-hidden="true" className="size-10 text-muted" strokeWidth={1.25} />
      <Heading className={headingLevel === 1 ? 'text-h1' : 'text-h2'}>{title}</Heading>
      {message !== undefined ? <p className="max-w-prose text-body text-muted">{message}</p> : null}
      {children}
      {actions !== undefined ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{actions}</div>
      ) : null}
      {details !== undefined ? (
        <details className="mt-4 text-body-sm text-muted">
          <summary className="min-h-6 cursor-pointer">{details.summary}</summary>
          <div className="mt-1 font-mono">{details.content}</div>
        </details>
      ) : null}
    </section>
  );
}
