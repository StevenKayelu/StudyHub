/**
 * Theme compiler for school accents (BR-51; blueprint 04 §17.7, 06 §10.1).
 *
 * Works in OKLCH. From one accent colour it derives the light and dark accent tokens
 * (`accent`, `accent-hover`, `on-accent`, `accent-soft`), adjusting lightness only, until every
 * required contrast passes. Colours that can't be made compliant without changing them beyond
 * recognition are rejected with three nearby compliant suggestions.
 *
 * Every check runs on the final 8-bit hex values, so rounding can't break a ratio.
 * Pure TypeScript: shared by the API (validation on save) and the web app (theme CSS).
 */
import { type AccentTokens, darkColors, lightColors } from '../tokens/tokens.js';
import { contrastRatio, deltaE, type Hex, hexToOklch, type Lch, normalizeHex, oklchToHex } from './color.js';

/** Minimum ratio for every accent pair (text-level, which also covers BR-51's 3:1 against backgrounds). */
export const ACCENT_MIN_CONTRAST = 4.5;

/**
 * The most the light accent may be darkened to pass. Beyond this the result no longer reads as the
 * school's colour, so it is rejected (with suggestions) rather than silently changed.
 */
export const MAX_LIGHTNESS_SHIFT = 0.15;

/**
 * Derivation offsets, fitted to the hand-tuned copper reference (06 §2.2) so that compiling
 * #A3471C reproduces it to within a just-noticeable difference (ΔE_OK < 0.02; see compiler.test.ts).
 */
const DERIVE = {
  light: { hoverL: -0.0587, hoverC: 0.8855, softL: 0.9361, softC: 0.191, softMaxC: 0.04 },
  dark: {
    accentL: 0.2187,
    accentC: 0.9603,
    hoverL: 0.0555,
    hoverC: 0.837,
    softL: 0.2847,
    softC: 0.296,
    softMaxC: 0.06,
    onL: 0.1784,
    onC: 0.187,
    onMaxC: 0.04,
  },
  step: 0.005,
} as const;

export type AccentRejection = 'INVALID_COLOR' | 'TOO_LIGHT' | 'NO_DARK_VARIANT';

/** Every pair the compiler guarantees, measured on the emitted hex values. */
export interface AccentRatios {
  accentOnCanvas: number;
  accentOnSurface: number;
  accentOnSoft: number;
  onAccentOnAccent: number;
  onAccentOnHover: number;
}

export interface CompiledAccent {
  input: Hex;
  light: AccentTokens;
  dark: AccentTokens;
  ratios: { light: AccentRatios; dark: AccentRatios };
  /** True when the light accent had to be darkened to pass (the editor says so). */
  adjusted: boolean;
}

export type CompileResult =
  | { ok: true; accent: CompiledAccent }
  | { ok: false; input: string; reason: AccentRejection; suggestions: Hex[] };

interface Backgrounds {
  canvas: Hex;
  surface: Hex;
}

const LIGHT_BG: Backgrounds = { canvas: lightColors['bg-canvas'], surface: lightColors['bg-surface'] };
const DARK_BG: Backgrounds = { canvas: darkColors['bg-canvas'], surface: darkColors['bg-surface'] };

function measure(tokens: AccentTokens, bg: Backgrounds): AccentRatios {
  return {
    accentOnCanvas: contrastRatio(tokens.accent, bg.canvas),
    accentOnSurface: contrastRatio(tokens.accent, bg.surface),
    accentOnSoft: contrastRatio(tokens.accent, tokens['accent-soft']),
    onAccentOnAccent: contrastRatio(tokens['on-accent'], tokens.accent),
    onAccentOnHover: contrastRatio(tokens['on-accent'], tokens['accent-hover']),
  };
}

export function ratiosPass(ratios: AccentRatios): boolean {
  return Object.values(ratios).every((ratio) => ratio >= ACCENT_MIN_CONTRAST);
}

const clampL = (l: number) => Math.min(Math.max(l, 0), 1);

function lightTokens(accent: Lch, accentHex?: Hex): AccentTokens {
  const d = DERIVE.light;
  return {
    accent: accentHex ?? oklchToHex(accent),
    'accent-hover': oklchToHex({ l: clampL(accent.l + d.hoverL), c: accent.c * d.hoverC, h: accent.h }),
    'on-accent': '#ffffff',
    'accent-soft': oklchToHex({ l: d.softL, c: Math.min(accent.c * d.softC, d.softMaxC), h: accent.h }),
  };
}

function darkTokens(accent: Lch, base: Lch): AccentTokens {
  const d = DERIVE.dark;
  return {
    accent: oklchToHex(accent),
    'accent-hover': oklchToHex({ l: clampL(accent.l + d.hoverL), c: accent.c * d.hoverC, h: accent.h }),
    'on-accent': oklchToHex({ l: d.onL, c: Math.min(base.c * d.onC, d.onMaxC), h: base.h }),
    'accent-soft': oklchToHex({ l: d.softL, c: Math.min(base.c * d.softC, d.softMaxC), h: base.h }),
  };
}

/** Darkens (light theme) from the input lightness until every pair passes. */
function solveLight(input: Hex, base: Lch): { tokens: AccentTokens; shift: number } | null {
  const exact = lightTokens(base, input);
  if (ratiosPass(measure(exact, LIGHT_BG))) return { tokens: exact, shift: 0 };
  for (let l = base.l - DERIVE.step; l >= 0; l -= DERIVE.step) {
    const tokens = lightTokens({ ...base, l });
    if (ratiosPass(measure(tokens, LIGHT_BG))) return { tokens, shift: base.l - l };
  }
  return null;
}

/** Starts from the fitted dark-theme lightness and raises it until every pair passes. */
function solveDark(base: Lch): AccentTokens | null {
  const d = DERIVE.dark;
  const c = base.c * d.accentC;
  for (let l = clampL(base.l + d.accentL); l <= 1; l += DERIVE.step) {
    const tokens = darkTokens({ l, c, h: base.h }, base);
    if (ratiosPass(measure(tokens, DARK_BG))) return tokens;
  }
  return null;
}

function compileValid(input: Hex): CompiledAccent | AccentRejection {
  const base = hexToOklch(input);
  const light = solveLight(input, base);
  if (light === null || light.shift > MAX_LIGHTNESS_SHIFT) return 'TOO_LIGHT';
  const dark = solveDark(base);
  if (dark === null) return 'NO_DARK_VARIANT';
  return {
    input,
    light: light.tokens,
    dark,
    ratios: { light: measure(light.tokens, LIGHT_BG), dark: measure(dark, DARK_BG) },
    adjusted: light.shift > 0,
  };
}

/** Compiles a school accent. Input: `#RRGGBB`. */
export function compileAccent(value: string): CompileResult {
  const input = normalizeHex(value);
  if (input === null) return { ok: false, input: value, reason: 'INVALID_COLOR', suggestions: [] };
  const result = compileValid(input);
  return typeof result === 'string'
    ? { ok: false, input, reason: result, suggestions: suggest(hexToOklch(input)) }
    : { ok: true, accent: result };
}

const SUGGESTION_HUE_OFFSETS = [0, -12, 12, -24, 24, -40, 40];

/**
 * Up to three compliant colours near a rejected one: for nearby hues, the lightest version that passes
 * as-is, ordered by perceptual distance. Every suggestion compiles unchanged (property-tested).
 */
function suggest(base: Lch): Hex[] {
  const origin = oklchToHex(base);
  const found: { hex: Hex; distance: number }[] = [];
  for (const offset of SUGGESTION_HUE_OFFSETS) {
    const hue = (base.h + offset + 360) % 360;
    for (let l = Math.min(base.l, 0.75); l >= 0.15; l -= 0.01) {
      const hex = oklchToHex({ l, c: base.c, h: hue });
      // Cheap check first: the colour must pass in the light theme exactly as it is.
      if (!ratiosPass(measure(lightTokens(hexToOklch(hex), hex), LIGHT_BG))) continue;
      const result = compileValid(hex);
      if (typeof result !== 'string' && !result.adjusted) {
        if (!found.some((entry) => entry.hex === hex)) found.push({ hex, distance: deltaE(hex, origin) });
        break;
      }
    }
  }
  const nearest = found.sort((a, b) => a.distance - b.distance).slice(0, 3);
  // Achromatic or narrow-gamut colours yield fewer distinct hues: add darker steps of the nearest one.
  const best = nearest[0];
  for (let step = 1; best !== undefined && nearest.length < 3 && step <= 10; step += 1) {
    const lch = hexToOklch(best.hex);
    const hex = oklchToHex({ ...lch, l: lch.l - 0.04 * step });
    const result = compileValid(hex);
    if (typeof result !== 'string' && !result.adjusted && !nearest.some((entry) => entry.hex === hex)) {
      nearest.push({ hex, distance: deltaE(hex, origin) });
    }
  }
  return nearest.map((entry) => entry.hex);
}
