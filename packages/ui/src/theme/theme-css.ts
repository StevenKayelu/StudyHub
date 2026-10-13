import { ACCENT_ROLES, type AccentTokens, consoleAccent } from '../tokens/tokens.js';
import type { CompiledAccent } from './compiler.js';

/** The three curated, self-hosted font pairs a school may choose (06 §10.1; F39). */
export const FONT_PRESETS = ['COPPERLINE', 'HUMANIST', 'GEOMETRIC'] as const;
export type FontPreset = (typeof FONT_PRESETS)[number];

/**
 * Families per preset. The web app self-hosts each file and exposes it as the CSS variable named
 * here (`--sh-font-{preset}-{ui|reading}`); a theme only switches which variables are in use, so
 * a school never loads arbitrary fonts.
 */
export const FONT_PRESET_FAMILIES: Record<FontPreset, { ui: string; reading: string }> = {
  COPPERLINE: { ui: 'Atkinson Hyperlegible Next', reading: 'Literata' },
  HUMANIST: { ui: 'Source Sans 3', reading: 'Source Serif 4' },
  GEOMETRIC: { ui: 'Plus Jakarta Sans', reading: 'Literata' },
};

export function fontPresetVariables(preset: FontPreset): { ui: string; reading: string } {
  const key = preset.toLowerCase();
  return { ui: `--sh-font-${key}-ui`, reading: `--sh-font-${key}-reading` };
}

function accentDeclarations(tokens: AccentTokens): string {
  return ACCENT_ROLES.map((role) => `--sh-color-${role}:${tokens[role]};`).join('');
}

export interface ThemeCssInput {
  /** A compiled school accent, or null to keep the Copperline default. */
  accent: CompiledAccent | null;
  fontPreset: FontPreset;
}

/**
 * The CSS a school's theme adds on top of `tokens.css`: accent tokens for both themes and the font
 * preset. Only identity tokens are emitted; structure, semantic colours and the focus ring stay fixed.
 * Selectors mirror tokens.css (system preference, overridable with `data-theme` on <html>).
 */
export function themeCss({ accent, fontPreset }: ThemeCssInput): string {
  const fonts = fontPresetVariables(fontPreset);
  const fontRules = `--sh-font-ui:var(${fonts.ui}),system-ui,sans-serif;--sh-font-reading:var(${fonts.reading}),Georgia,serif;`;
  if (accent === null) return `:root{${fontRules}}`;
  const light = accentDeclarations(accent.light);
  const dark = accentDeclarations(accent.dark);
  return (
    `:root{${fontRules}${light}}` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${dark}}}` +
    `:root[data-theme=dark]{${dark}}`
  );
}

/** The platform console's fixed theme (info blue). Never combined with a school theme (06 §10.3). */
export function consoleThemeCss(): string {
  const dark = accentDeclarations(consoleAccent.dark);
  return (
    `:root{${accentDeclarations(consoleAccent.light)}}` +
    `@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${dark}}}` +
    `:root[data-theme=dark]{${dark}}`
  );
}
