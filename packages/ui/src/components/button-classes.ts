import { cx } from './cx.js';

// Kept out of button.tsx ('use client') so server components can style links as buttons.

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

const variants: Record<ButtonVariant, string> = {
  // The accent: one primary action per view region (06 §2.5, UX-11).
  primary: 'bg-accent text-on-accent border border-transparent hover:bg-accent-hover',
  secondary: 'bg-surface text-ink border border-strong hover:bg-sunken',
  ghost: 'bg-transparent text-ink border border-transparent hover:bg-sunken',
  // Destructive actions use danger, never the accent.
  danger: 'bg-danger text-surface border border-transparent hover:opacity-90',
};

const sizes: Record<ButtonSize, string> = {
  md: 'min-h-11 px-4 text-label', // 44 px
  sm: 'min-h-9 px-3 text-label', // 36 px, dense desktop only
};

export function buttonClasses(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return cx(
    'inline-flex items-center justify-center gap-2 rounded-md font-ui whitespace-nowrap no-underline',
    'transition-colors duration-fast ease-standard select-none',
    // Disabled controls keep readable text (06 §2.6): no opacity-only treatment.
    'disabled:cursor-not-allowed disabled:border-line disabled:bg-sunken disabled:text-subtle',
    variants[variant],
    sizes[size],
  );
}
