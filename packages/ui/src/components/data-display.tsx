import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

import { cx } from './cx.js';

export function Card({
  children,
  className,
  'data-testid': testId,
}: {
  children: ReactNode;
  className?: string;
  /** Passed through for end-to-end tests. */
  'data-testid'?: string;
}) {
  // Flat, bordered surface: no shadow (06 §1.3).
  return (
    <div className={cx('rounded-md border border-line bg-surface p-4', className)} data-testid={testId}>
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  detail,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <Card>
      <p className="text-body-sm text-muted">{label}</p>
      <p className="tabular mt-1 text-h2 text-ink">{value}</p>
      {detail !== undefined ? <p className="mt-1 text-caption text-subtle">{detail}</p> : null}
    </Card>
  );
}

export interface MoneyProps {
  /** Amount in minor units (ngwee for ZMW). */
  amountMinor: number;
  currency: string;
  locale: string;
  /** Shown instead of a zero amount, e.g. "Free" (06 §2.5). */
  freeLabel?: string;
}

/** Formats money with Intl and tabular figures: "K250.00". */
export function formatMoney(amountMinor: number, currency: string, locale: string): string {
  const format = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(amountMinor / 10 ** digits);
}

export function Money({ amountMinor, currency, locale, freeLabel }: MoneyProps) {
  if (amountMinor === 0 && freeLabel !== undefined) return <span>{freeLabel}</span>;
  return <span className="tabular">{formatMoney(amountMinor, currency, locale)}</span>;
}

export interface ProgressLineProps {
  value: number;
  max: number;
  /** Visible and accessible text, e.g. "6 of 14 lessons". */
  label: string;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

/** The signature accent line carrying progress (06 §1.3, §2.5). */
export function ProgressLine({
  value,
  max,
  label,
  orientation = 'horizontal',
  className,
}: ProgressLineProps) {
  const percent = max > 0 ? Math.min(Math.max(value / max, 0), 1) * 100 : 0;
  const vertical = orientation === 'vertical';
  return (
    <div className={cx('flex gap-2', vertical ? 'h-full flex-row' : 'flex-col', className)}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={label}
        aria-label={label}
        className={cx(
          'overflow-hidden rounded-full bg-sunken',
          vertical ? 'h-full w-[3px]' : 'h-[3px] w-full',
        )}
      >
        <div
          className="rounded-full bg-accent"
          style={
            vertical ? { height: `${percent}%`, width: '100%' } : { width: `${percent}%`, height: '100%' }
          }
        />
      </div>
      <span className="text-caption text-muted">{label}</span>
    </div>
  );
}

export interface StepperProps {
  /** Accessible name, e.g. "Checkout progress". */
  label: string;
  steps: string[];
  /** Zero-based index of the current step. */
  current: number;
  /** Screen-reader text appended to completed steps, e.g. "completed". */
  completedLabel: string;
}

/** Steps joined by the accent line (checkout, applications, console tenant creation). */
export function Stepper({ label, steps, current, completedLabel }: StepperProps) {
  return (
    <nav aria-label={label}>
      <ol className="flex items-start gap-2">
        {steps.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={step} className="flex flex-1 flex-col gap-2" aria-current={active ? 'step' : undefined}>
              <span className={cx('h-[3px] rounded-full', done || active ? 'bg-accent' : 'bg-sunken')} />
              <span
                className={cx('flex items-center gap-1 text-caption', active ? 'text-ink' : 'text-muted')}
              >
                {done ? (
                  <Check aria-hidden="true" className="size-3.5 text-accent" strokeWidth={2.5} />
                ) : null}
                {step}
                {done ? <span className="sr-only">({completedLabel})</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
