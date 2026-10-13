/**
 * Copperline design tokens (blueprint 06 §2). The single source of truth: `src/styles/tokens.css` is
 * generated from this file (`pnpm --filter @studyhub/ui tokens`) and a test fails if they drift.
 *
 * Naming: `--sh-{category}-{role}-{variant?}` (06 §2.1). Components use semantic tokens only.
 */
import type { Hex } from '../theme/color.js';

export type ColorRole =
  | 'bg-canvas'
  | 'bg-surface'
  | 'bg-sunken'
  | 'text-default'
  | 'text-muted'
  | 'text-subtle'
  | 'border-default'
  | 'border-strong'
  | 'accent'
  | 'accent-hover'
  | 'on-accent'
  | 'accent-soft'
  | 'success'
  | 'success-soft'
  | 'info'
  | 'info-soft'
  | 'warning'
  | 'warning-soft'
  | 'danger'
  | 'danger-soft'
  | 'focus-ring';

export type ColorScheme = Record<ColorRole, Hex>;

/** 06 §2.2, light theme (paper). */
export const lightColors: ColorScheme = {
  'bg-canvas': '#f7f5f0',
  'bg-surface': '#ffffff',
  'bg-sunken': '#efece5',
  'text-default': '#1c2126',
  'text-muted': '#4a535c',
  'text-subtle': '#636b73',
  'border-default': '#dad5cb',
  'border-strong': '#857e71',
  accent: '#a3471c',
  'accent-hover': '#8a3b16',
  'on-accent': '#ffffff',
  'accent-soft': '#f8e6da',
  success: '#0e6a4e',
  'success-soft': '#ddf1e8',
  info: '#1d5da6',
  'info-soft': '#e0ecf9',
  warning: '#7f5300',
  'warning-soft': '#fcefcf',
  danger: '#b0261d',
  'danger-soft': '#fbe3e1',
  'focus-ring': '#1d5da6',
};

/** 06 §2.2, dark theme (slate). `bg-sunken` is the raised surface in dark mode. */
export const darkColors: ColorScheme = {
  'bg-canvas': '#111416',
  'bg-surface': '#191d21',
  'bg-sunken': '#21262b',
  'text-default': '#ece9e2',
  'text-muted': '#b7bcc1',
  'text-subtle': '#9199a0',
  'border-default': '#30373d',
  'border-strong': '#6e777f',
  accent: '#e98d5e',
  'accent-hover': '#f2a47c',
  'on-accent': '#1a0e07',
  'accent-soft': '#3a2418',
  success: '#4dc69b',
  'success-soft': '#12302a',
  info: '#83b3f2',
  'info-soft': '#152639',
  warning: '#e9b24a',
  'warning-soft': '#33280f',
  danger: '#f28c83',
  'danger-soft': '#3a1a18',
  'focus-ring': '#83b3f2',
};

/** The four tokens a school's accent replaces (06 §10.1). Everything else is fixed. */
export const ACCENT_ROLES = ['accent', 'accent-hover', 'on-accent', 'accent-soft'] as const;
export type AccentRole = (typeof ACCENT_ROLES)[number];
export type AccentTokens = Record<AccentRole, Hex>;

/** The platform console's fixed accent: info blue, never copper or a school's colour (06 §10.3). */
export const consoleAccent: { light: AccentTokens; dark: AccentTokens } = {
  light: { accent: '#1d5da6', 'accent-hover': '#174c89', 'on-accent': '#ffffff', 'accent-soft': '#e0ecf9' },
  dark: { accent: '#83b3f2', 'accent-hover': '#a3c7f6', 'on-accent': '#0b1a2c', 'accent-soft': '#152639' },
};

/** 06 §2.4. Pixel values; emitted as rem where they size text-bearing layout. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64 } as const;
export const radius = { sm: 4, md: 8, lg: 12, full: 9999 } as const;
export const elevation = {
  0: 'none',
  1: '0 4px 12px rgb(0 0 0 / 0.12)',
  2: '0 12px 32px rgb(0 0 0 / 0.18)',
} as const;
export const duration = { fast: 120, medium: 200, slow: 280 } as const;
export const easing = 'cubic-bezier(.2,0,0,1)';
export const zIndex = { base: 0, sticky: 10, rail: 20, overlay: 40, dialog: 50, toast: 60 } as const;
export const breakpoints = { medium: 600, expanded: 1024, wide: 1440 } as const;
export const containers = { reading: 720, app: 1280 } as const;

/** 06 §2.3: `[size px, line-height px]` at compact and expanded widths, and the weight. */
export const typeScale = {
  display: { compact: [30, 36], expanded: [40, 48], weight: 700 },
  h1: { compact: [26, 32], expanded: [32, 40], weight: 700 },
  h2: { compact: [22, 28], expanded: [24, 32], weight: 700 },
  h3: { compact: [18, 26], expanded: [20, 28], weight: 600 },
  'body-lg': { compact: [18, 30], expanded: [18, 30], weight: 400 },
  body: { compact: [16, 24], expanded: [16, 24], weight: 400 },
  'body-sm': { compact: [14, 20], expanded: [14, 20], weight: 400 },
  caption: { compact: [13, 18], expanded: [13, 18], weight: 500 },
  label: { compact: [14, 20], expanded: [14, 20], weight: 600 },
} as const satisfies Record<
  string,
  { compact: readonly [number, number]; expanded: readonly [number, number]; weight: number }
>;

/** Text pairs that must meet 4.5:1 and UI pairs that must meet 3:1 (06 §2.2; UX-09). */
export const contrastRequirements: readonly { fg: ColorRole; bg: ColorRole; min: number }[] = [
  ...(['bg-canvas', 'bg-surface'] as const).flatMap((bg) =>
    (
      ['text-default', 'text-muted', 'text-subtle', 'accent', 'success', 'info', 'warning', 'danger'] as const
    ).map((fg) => ({ fg, bg, min: 4.5 })),
  ),
  { fg: 'text-default', bg: 'bg-sunken', min: 4.5 },
  { fg: 'text-muted', bg: 'bg-sunken', min: 4.5 },
  { fg: 'text-subtle', bg: 'bg-sunken', min: 4.5 },
  { fg: 'on-accent', bg: 'accent', min: 4.5 },
  { fg: 'on-accent', bg: 'accent-hover', min: 4.5 },
  { fg: 'accent', bg: 'accent-soft', min: 4.5 },
  { fg: 'text-default', bg: 'accent-soft', min: 4.5 },
  { fg: 'success', bg: 'success-soft', min: 4.5 },
  { fg: 'info', bg: 'info-soft', min: 4.5 },
  { fg: 'warning', bg: 'warning-soft', min: 4.5 },
  { fg: 'danger', bg: 'danger-soft', min: 4.5 },
  { fg: 'border-strong', bg: 'bg-surface', min: 3 },
  { fg: 'focus-ring', bg: 'bg-canvas', min: 3 },
  { fg: 'focus-ring', bg: 'bg-surface', min: 3 },
];
