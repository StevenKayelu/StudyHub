'use client';

import { Slot } from 'radix-ui';
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';

import { type ButtonSize, buttonClasses, type ButtonVariant } from './button-classes.js';
import { cx } from './cx.js';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and `loadingLabel` (e.g. "Saving…"), keeping the button usable for screen readers. */
  loading?: boolean;
  loadingLabel?: string;
  /** Render the child element (e.g. a link) with button styling. */
  asChild?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    loadingLabel,
    asChild = false,
    icon,
    className,
    children,
    disabled,
    type,
    ...rest
  },
  ref,
) {
  const classes = cx(buttonClasses(variant, size), className);
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <>
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
          <span>{loadingLabel ?? children}</span>
        </>
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </button>
  );
});
